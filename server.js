import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import square from "square";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile } from "node:fs/promises";

const { SquareClient, SquareEnvironment } = square;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.join(__dirname, ".env"),
  override: true,
});

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const allowedOrigins = (frontendOrigin || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const defaultProdOrigins = [
  "https://bbs-bakery.com",
  "https://www.bbs-bakery.com",
];

const defaultDevOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const normalizeOrigin = (origin) => {
  if (!origin) {
    return "";
  }

  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(origin).trim().replace(/\/$/, "");
  }
};

const originAllowList = new Set(
  [...allowedOrigins, ...defaultProdOrigins, ...defaultDevOrigins].map(normalizeOrigin),
);

app.use(
  cors({
    origin(origin, callback) {
      const normalizedRequestOrigin = normalizeOrigin(origin);
      if (
        !origin ||
        originAllowList.size === 0 ||
        originAllowList.has(normalizedRequestOrigin)
      ) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  }),
);
app.use(express.json());

const squareEnvironment =
  process.env.SQUARE_ENVIRONMENT === "production"
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: squareEnvironment,
});

const squareLocationId = process.env.SQUARE_LOCATION_ID || process.env.LOCATION_ID;

const stateTaxPercent = Number(process.env.STATE_TAX_PERCENT || 0);
const townTaxPercent = Number(process.env.TOWN_TAX_PERCENT || 0);
const salesTaxPercent = Number(process.env.SALES_TAX_PERCENT || 0);

const adminUsername = process.env.ADMIN_USERNAME || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const adminJwtSecret = process.env.ADMIN_JWT_SECRET || "";

const ordersStoreFilePath = path.join(__dirname, "orders.json");
const MAX_ORDERS = 100;

const normalizeCustomerName = (value) => String(value || "").trim();

const readOrdersStore = async () => {
  try {
    const raw = await readFile(ordersStoreFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.orders) ? parsed.orders : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const writeOrdersStore = async (orders) => {
  const output = {
    orders: Array.isArray(orders) ? orders.slice(0, MAX_ORDERS) : [],
  };
  await writeFile(ordersStoreFilePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
};

const createTrackedOrder = async (orderData) => {
  const currentOrders = await readOrdersStore();
  const now = new Date().toISOString();
  const order = {
    id: crypto.randomUUID(),
    status: "pending",
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    customerName: normalizeCustomerName(orderData.customerName) || "Guest",
    items: Array.isArray(orderData.items) ? orderData.items : [],
    total: typeof orderData.total === "number" ? orderData.total : null,
    orderId: orderData.orderId || "",
    paymentLinkId: orderData.paymentLinkId || "",
    squareOrderVersion: null,
    fulfillmentUid: null,
    paidAt: null,
    completedAt: null,
    dismissedAt: null,
  };

  const nextOrders = [order, ...currentOrders.filter((entry) => entry.orderId !== order.orderId)];
  await writeOrdersStore(nextOrders);
  return order;
};

const getPrimaryFulfillment = (squareOrder) => {
  const fulfillments = Array.isArray(squareOrder?.fulfillments) ? squareOrder.fulfillments : [];
  return fulfillments[0] || null;
};

const isSquareOrderPaid = (squareOrder) => {
  if (!squareOrder || squareOrder.state === "CANCELED") {
    return false;
  }

  const tenders = Array.isArray(squareOrder.tenders) ? squareOrder.tenders : [];
  if (tenders.length > 0) {
    return true;
  }

  const tenderIds = Array.isArray(squareOrder.tender_ids) ? squareOrder.tender_ids : [];
  if (tenderIds.length > 0) {
    return true;
  }

  const netAmountDue = squareOrder?.net_amount_due_money?.amount;
  return typeof netAmountDue === "number" && netAmountDue === 0;
};

const hasCompletedPaymentForOrder = async (orderId) => {
  if (!orderId || orderId === "unknown") {
    return false;
  }

  try {
    const query = new URLSearchParams({
      order_id: orderId,
      limit: "5",
      sort_order: "DESC",
    });

    const response = await squareRequest(`/v2/payments?${query.toString()}`);
    const payments = Array.isArray(response?.payments) ? response.payments : [];

    return payments.some((payment) => {
      const status = String(payment?.status || "").toUpperCase();
      return status === "COMPLETED" || status === "APPROVED";
    });
  } catch {
    return false;
  }
};

const reconcileTrackedOrders = async () => {
  const currentOrders = await readOrdersStore();

  const reconciledOrders = await Promise.all(
    currentOrders.map(async (trackedOrder) => {
      if (
        !trackedOrder?.orderId ||
        trackedOrder.orderId === "unknown" ||
        trackedOrder.status === "completed" ||
        trackedOrder.status === "dismissed"
      ) {
        return trackedOrder;
      }

      try {
        const response = await squareRequest(`/v2/orders/${trackedOrder.orderId}`);
        const squareOrder = response?.order;

        if (!squareOrder) {
          return trackedOrder;
        }

        const primaryFulfillment = getPrimaryFulfillment(squareOrder);
        const paid =
          isSquareOrderPaid(squareOrder) ||
          (trackedOrder.status !== "paid" && (await hasCompletedPaymentForOrder(trackedOrder.orderId)));
        const nextStatus = primaryFulfillment?.state === "COMPLETED"
          ? "completed"
          : paid
            ? "paid"
            : "pending";

        return {
          ...trackedOrder,
          total:
            typeof squareOrder?.total_money?.amount === "number"
              ? squareOrder.total_money.amount
              : trackedOrder.total,
          squareOrderVersion:
            typeof squareOrder?.version === "number"
              ? squareOrder.version
              : trackedOrder.squareOrderVersion,
          fulfillmentUid: primaryFulfillment?.uid || trackedOrder.fulfillmentUid,
          status: nextStatus,
          paidAt: paid ? trackedOrder.paidAt || new Date().toISOString() : trackedOrder.paidAt,
          completedAt:
            nextStatus === "completed"
              ? trackedOrder.completedAt || new Date().toISOString()
              : trackedOrder.completedAt,
          updatedAt: new Date().toISOString(),
        };
      } catch {
        return trackedOrder;
      }
    }),
  );

  await writeOrdersStore(reconciledOrders);
  return reconciledOrders;
};

const updateTrackedOrder = async (orderId, transform) => {
  const currentOrders = await readOrdersStore();
  const index = currentOrders.findIndex((order) => order.orderId === orderId);

  if (index === -1) {
    return null;
  }

  

  const updatedOrder = {
    ...currentOrders[index],
    ...transform(currentOrders[index]),
    updatedAt: new Date().toISOString(),
  };

  currentOrders[index] = updatedOrder;
  await writeOrdersStore(currentOrders);
  return updatedOrder;
};

const squareApiBaseUrl =
  process.env.SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

const sectionOptions = [
  "Baked Goods",
  "Breakfast",
  "Lunch",
  "Loaded Energy",
  "Specialty Coffee",
  "Classic Espresso",
  "Iced Latte",
  "Hot Latte",
  "Frappes",
  "💥 Dirty Sodas & Lemonades",
  "🍓 Smoothies",
];

const curatedDefaultItems = [
  { name: "Muffins", section: "Baked Goods" },
  { name: "Brownies", section: "Baked Goods" },
  { name: "Scones", section: "Baked Goods" },
  { name: "Cinnamon Rolls", section: "Baked Goods" },
  { name: "Coffee Cake", section: "Baked Goods" },
  { name: "Cream Horns", section: "Baked Goods" },
  { name: "Savory Biscuit", section: "Breakfast" },
  { name: "Breakfast Biscuit", section: "Breakfast" },
  { name: "Breakfast Sandwich", section: "Breakfast" },
  { name: "Breakfast Wrap", section: "Breakfast" },
  { name: "Omelette", section: "Breakfast" },
  { name: "BB's Signature Grilled Cheese", section: "Lunch" },
  { name: "Grilled Cheese", section: "Lunch" },
  { name: "BB's Buttery BLT", section: "Lunch" },
  { name: "BLT", section: "Lunch" },
  { name: "Chicken Salad Croissant", section: "Lunch" },
  { name: "BB's Croissant Club", section: "Lunch" },
  { name: "Croissant Club", section: "Lunch" },
  { name: "Italian Wrap", section: "Lunch" },
  { name: "Buffalo Chicken Wrap", section: "Lunch" },
  { name: "Buffalo Chicken wrap", section: "Lunch" },
  { name: "Tater Colada", section: "Loaded Energy" },
  { name: "Blushing Belle", section: "Loaded Energy" },
  { name: "Rip-Tide", section: "Loaded Energy" },
  { name: "Wrecking Ball", section: "Loaded Energy" },
  { name: "Fruit Roll-Up", section: "Loaded Energy" },
  { name: "BB's Fav", section: "Loaded Energy" },
  { name: "Honey's Tropical Tumble", section: "Loaded Energy" },
  { name: "Smokin' Ash", section: "Loaded Energy" },
  { name: "Tiramisu", section: "Specialty Coffee" },
  { name: "Cookies & Cream", section: "Specialty Coffee" },
  { name: "Smore's", section: "Specialty Coffee" },
  { name: "White Chocolate Raspberry", section: "Specialty Coffee" },
  { name: "Caramel Kolb", section: "Specialty Coffee" },
  { name: "Cinnamon Roll", section: "Specialty Coffee" },
  { name: "Conor McGregor", section: "Specialty Coffee" },
  { name: "Blackstone", section: "Specialty Coffee" },
  { name: "Peppermint Mocha", section: "Specialty Coffee" },
  { name: "Caramel Toast Crunch", section: "Specialty Coffee" },
  { name: "White Nut", section: "Specialty Coffee" },
  { name: "Mocha Nut", section: "Specialty Coffee" },
  { name: "Americano", section: "Classic Espresso" },
  { name: "Cappuccino", section: "Classic Espresso" },
  { name: "Cortado", section: "Classic Espresso" },
  { name: "Iced Latte", section: "Iced Latte" },
  { name: "Hot Latte", section: "Hot Latte" },
  { name: "Frappe", section: "Frappes" },
  { name: "Dirty Soda & Lemonade", section: "💥 Dirty Sodas & Lemonades" },
  { name: "Smoothie", section: "🍓 Smoothies" },
];

const menuMetadataFilePath = path.join(__dirname, "menu-sections.json");

const normalizeKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const curatedDefaultsByName = new Map(
  curatedDefaultItems.map((entry) => [normalizeKey(entry.name), entry.section]),
);

const getSafeSection = (section) =>
  sectionOptions.includes(section) ? section : "Baked Goods";

const getSafeVisible = (visible) => visible !== false;

const toMetadataEntry = (entry, fallback = { section: "Baked Goods", visible: false }) => {
  if (entry && typeof entry === "object") {
    return {
      section: getSafeSection(entry.section),
      visible: getSafeVisible(entry.visible),
    };
  }

  if (typeof entry === "string") {
    return {
      section: getSafeSection(entry),
      visible: getSafeVisible(fallback.visible),
    };
  }

  return {
    section: getSafeSection(fallback.section),
    visible: getSafeVisible(fallback.visible),
  };
};

const readMenuMetadata = async () => {
  try {
    const raw = await readFile(menuMetadataFilePath, "utf8");
    const parsed = JSON.parse(raw);
    const rawById = parsed?.byId && typeof parsed.byId === "object" ? parsed.byId : {};
    const rawByName = parsed?.byName && typeof parsed.byName === "object" ? parsed.byName : {};

    const byId = Object.fromEntries(
      Object.entries(rawById).map(([id, entry]) => [id, toMetadataEntry(entry)]),
    );
    const byName = Object.fromEntries(
      Object.entries(rawByName).map(([nameKey, entry]) => [nameKey, toMetadataEntry(entry)]),
    );

    return {
      byId,
      byName,
    };
  } catch {
    return { byId: {}, byName: {} };
  }
};

const writeMenuMetadata = async (metadata) => {
  const output = {
    byId: metadata?.byId || {},
    byName: metadata?.byName || {},
  };
  await writeFile(menuMetadataFilePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
};

const squareHeaders = () => ({
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2026-03-18",
});

const toBase64Url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const createAdminToken = () => {
  const payload = {
    sub: "admin",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = toBase64Url(
    crypto.createHmac("sha256", adminJwtSecret).update(encodedPayload).digest(),
  );

  return `${encodedPayload}.${signature}`;
};

const verifyAdminToken = (token) => {
  if (!token || !adminJwtSecret) {
    return false;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = toBase64Url(
    crypto.createHmac("sha256", adminJwtSecret).update(encodedPayload).digest(),
  );

  if (expectedSignature !== signature) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return payload?.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const requireAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !verifyAdminToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
};

const squareRequest = async (pathname, options = {}) => {
  const response = await fetch(`${squareApiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      ...squareHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.errors?.map((error) => error.detail).join("; ");
    throw new Error(detail || "Square API request failed");
  }

  return data;
};

const normalizeCatalogItems = (objects = [], menuMetadata = { byId: {}, byName: {} }) => {
  return objects
    .filter((object) => object.type === "ITEM" && !object.is_deleted)
    .map((item) => {
      const itemData = item.item_data || {};
      const normalizedName = normalizeKey(itemData.name || "");
      const curatedDefaultSection = curatedDefaultsByName.get(normalizedName) || "Baked Goods";
      const curatedDefaultVisible = curatedDefaultsByName.has(normalizedName);
      const byIdEntry = menuMetadata?.byId?.[item.id];
      const byNameEntry = menuMetadata?.byName?.[normalizedName];

      const isLegacyHiddenDefault =
        byIdEntry?.section === "Baked Goods" && byIdEntry?.visible === false;

      const shouldPreferCuratedDefault =
        curatedDefaultsByName.has(normalizedName) && !byNameEntry && isLegacyHiddenDefault;

      const metadata = toMetadataEntry(
        shouldPreferCuratedDefault ? undefined : (byIdEntry || byNameEntry),
        { section: curatedDefaultSection, visible: curatedDefaultVisible },
      );
      const variations = (itemData.variations || [])
        .filter((variation) => variation.type === "ITEM_VARIATION" && !variation.is_deleted)
        .map((variation) => {
          const variationData = variation.item_variation_data || {};
          const money = variationData.price_money || {};

          return {
            id: variation.id,
            name: variationData.name || "Regular",
            priceAmount: typeof money.amount === "number" ? money.amount : null,
            currency: money.currency || "USD",
          };
        });

      return {
        id: item.id,
        version: item.version,
        name: itemData.name || "",
        description: itemData.description || "",
        categoryId: itemData.category_id || null,
        section: metadata.section,
        visible: metadata.visible,
        variations,
      };
    });
};

const fetchAllCatalogItems = async () => {
  const objects = [];
  let cursor;
  const menuMetadata = await readMenuMetadata();

  do {
    const page = await squareRequest("/v2/catalog/search", {
      method: "POST",
      body: JSON.stringify({
        object_types: ["ITEM"],
        include_deleted_objects: false,
        limit: 100,
        cursor,
      }),
    });

    if (Array.isArray(page.objects)) {
      objects.push(...page.objects);
    }

    cursor = page.cursor;
  } while (cursor);

  return normalizeCatalogItems(objects, menuMetadata);
};

const ORDERABLE_SECTIONS = new Set(["Breakfast", "Lunch"]);
const PREORDER_ORDERABLE_NAMES = new Set([
  "white bread",
  "cinnamon raisin bread",
  "cheddar jalopeno bread",
]);

const getOrderableVariationIds = async () => {
  const items = await fetchAllCatalogItems();
  const ids = new Set();

  items.forEach((item) => {
    const normalizedName = normalizeKey(item?.name || "");
    const isStandardOnlineOrderable = ORDERABLE_SECTIONS.has(item?.section) && item?.visible !== false;
    const isPreOrderBread = PREORDER_ORDERABLE_NAMES.has(normalizedName);

    if (!isStandardOnlineOrderable && !isPreOrderBread) {
      return;
    }

    (item.variations || []).forEach((variation) => {
      if (variation?.id) {
        ids.add(variation.id);
      }
    });
  });

  return ids;
};

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!adminUsername || !adminPassword || !adminJwtSecret) {
    return res.status(500).json({ error: "Admin auth env vars are not configured" });
  }

  if (username !== adminUsername || password !== adminPassword) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  return res.json({ token: createAdminToken() });
});

app.get("/admin/orders", requireAdmin, async (_req, res) => {
  try {
    const trackedOrders = await reconcileTrackedOrders();
    const orders = trackedOrders
      .filter((order) => order.status === "paid")
      .slice(0, 50);

    return res.json({ orders });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load orders" });
  }
});

app.patch("/admin/orders/:orderId/complete", requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const currentOrderResponse = await squareRequest(`/v2/orders/${orderId}`);
    const currentOrder = currentOrderResponse?.order;

    if (!currentOrder) {
      return res.status(404).json({ error: "Order not found in Square" });
    }

    const primaryFulfillment = getPrimaryFulfillment(currentOrder);
    if (!primaryFulfillment?.uid) {
      return res.status(400).json({ error: "Order does not have a pickup fulfillment to complete" });
    }

    await squareRequest(`/v2/orders/${orderId}`, {
      method: "PUT",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: currentOrder.location_id || squareLocationId,
          version: currentOrder.version,
          fulfillments: (currentOrder.fulfillments || []).map((fulfillment) => ({
            uid: fulfillment.uid,
            type: fulfillment.type,
            state: fulfillment.uid === primaryFulfillment.uid ? "COMPLETED" : fulfillment.state,
          })),
        },
      }),
    });

    await updateTrackedOrder(orderId, () => ({
      status: "completed",
      completedAt: new Date().toISOString(),
    }));

    console.log("[admin] Order marked complete:", orderId);
    return res.json({ success: true });
  } catch (error) {
    console.error("[admin] Failed to complete order:", error);
    const squareDetail =
      error?.body?.errors?.[0]?.detail ||
      error?.result?.errors?.[0]?.detail ||
      error?.message ||
      "Failed to update order";
    return res.status(500).json({ error: squareDetail });
  }
});

app.delete("/admin/orders/:orderId", requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const updatedOrder = await updateTrackedOrder(orderId, () => ({
      status: "dismissed",
      dismissedAt: new Date().toISOString(),
    }));

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to remove order" });
  }
});

app.get("/menu", async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Missing Square backend configuration" });
    }

    const includeHidden = req.query.includeHidden === "true";
    const items = await fetchAllCatalogItems();
    const filteredItems = includeHidden ? items : items.filter((item) => item.visible !== false);
    return res.json({ items: filteredItems });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load menu" });
  }
});

app.get("/admin/items", requireAdmin, async (_req, res) => {
  try {
    const items = await fetchAllCatalogItems();
    return res.json({ items });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load admin items" });
  }
});

app.post("/admin/items", requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description = "",
      categoryId = null,
      variations = [],
      section = "Baked Goods",
      visible = true,
    } = req.body || {};

    if (!name || !Array.isArray(variations) || variations.length === 0) {
      return res.status(400).json({ error: "name and at least one variation are required" });
    }

    const tempItemId = `#item-${Date.now()}`;
    const squareVariations = variations.map((variation, index) => ({
      type: "ITEM_VARIATION",
      id: `#variation-${index + 1}`,
      item_variation_data: {
        name: variation?.name || "Regular",
        pricing_type: "FIXED_PRICING",
        price_money: {
          amount: Number(variation?.priceAmount),
          currency: variation?.currency || "USD",
        },
      },
    }));

    const response = await squareRequest("/v2/catalog/object", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        object: {
          type: "ITEM",
          id: tempItemId,
          item_data: {
            name,
            description,
            category_id: categoryId,
            variations: squareVariations,
          },
        },
      }),
    });

    const savedItem = response.catalog_object;
    if (savedItem?.id) {
      const menuMetadata = await readMenuMetadata();
      const safeSection = getSafeSection(section);
      const safeVisible = getSafeVisible(visible);
      const entry = { section: safeSection, visible: safeVisible };
      menuMetadata.byId[savedItem.id] = entry;
      menuMetadata.byName[normalizeKey(name)] = entry;
      await writeMenuMetadata(menuMetadata);
    }

    return res.status(201).json({ item: response.catalog_object });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create item" });
  }
});

app.patch("/admin/items/:itemId", requireAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;
    const {
      name,
      description = "",
      categoryId = null,
      variations = [],
      section = "Baked Goods",
      visible = true,
    } = req.body || {};

    if (!itemId || !name || !Array.isArray(variations) || variations.length === 0) {
      return res
        .status(400)
        .json({ error: "itemId, name and at least one variation are required" });
    }

    const current = await squareRequest(`/v2/catalog/object/${itemId}`);
    const currentObject = current.object;

    if (!currentObject || currentObject.type !== "ITEM") {
      return res.status(404).json({ error: "Item not found" });
    }

    const existingVariations = currentObject.item_data?.variations || [];
    const squareVariations = variations.map((variation, index) => {
      const existing = existingVariations[index];

      return {
        type: "ITEM_VARIATION",
        id: existing?.id || `#variation-${index + 1}`,
        version: existing?.version,
        item_variation_data: {
          name: variation?.name || "Regular",
          pricing_type: "FIXED_PRICING",
          price_money: {
            amount: Number(variation?.priceAmount),
            currency: variation?.currency || "USD",
          },
        },
      };
    });

    const response = await squareRequest("/v2/catalog/object", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        object: {
          type: "ITEM",
          id: currentObject.id,
          version: currentObject.version,
          item_data: {
            name,
            description,
            category_id: categoryId,
            variations: squareVariations,
          },
        },
      }),
    });

    const menuMetadata = await readMenuMetadata();
    const safeSection = getSafeSection(section);
    const safeVisible = getSafeVisible(visible);
    const entry = { section: safeSection, visible: safeVisible };
    menuMetadata.byId[itemId] = entry;
    menuMetadata.byName[normalizeKey(name)] = entry;
    await writeMenuMetadata(menuMetadata);

    return res.json({ item: response.catalog_object });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to update item" });
  }
});

app.patch("/admin/items/:itemId/visibility", requireAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { visible } = req.body || {};

    if (!itemId) {
      return res.status(400).json({ error: "itemId is required" });
    }

    const menuMetadata = await readMenuMetadata();
    const currentEntry = toMetadataEntry(menuMetadata.byId[itemId]);
    const nextEntry = {
      ...currentEntry,
      visible: getSafeVisible(visible),
    };

    menuMetadata.byId[itemId] = nextEntry;
    await writeMenuMetadata(menuMetadata);

    return res.json({ itemId, visible: nextEntry.visible });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to update visibility" });
  }
});

app.delete("/admin/items/:itemId", requireAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;

    if (!itemId) {
      return res.status(400).json({ error: "itemId is required" });
    }

    await squareRequest(`/v2/catalog/object/${itemId}`, {
      method: "DELETE",
    });

    const menuMetadata = await readMenuMetadata();
    if (menuMetadata.byId[itemId]) {
      delete menuMetadata.byId[itemId];
      await writeMenuMetadata(menuMetadata);
    }

    return res.status(204).send();
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to delete item" });
  }
});

app.post("/create-checkout", async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN || !squareLocationId) {
      return res.status(500).json({ error: "Missing Square backend configuration" });
    }

    const { items, customerName } = req.body;
    const normalizedCustomerName = normalizeCustomerName(customerName);
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const orderableVariationIds = await getOrderableVariationIds();

    const invalidItemNames = [];

    items.forEach((item) => {
      const variationId =
        typeof item?.variationId === "string" ? item.variationId.trim() : "";
      const quantity = Number(item?.quantity);
      const itemName = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "Unknown item";

      if (!Number.isFinite(quantity) || quantity <= 0) {
        invalidItemNames.push(itemName);
        return;
      }

      if (!variationId) {
        invalidItemNames.push(itemName);
        return;
      }

      if (!orderableVariationIds.has(variationId)) {
        invalidItemNames.push(itemName);
      }
    });

    if (invalidItemNames.length > 0) {
      return res.status(400).json({
        error: "Invalid cart items",
        details: `These items are not currently available for online checkout: ${invalidItemNames.join(", ")}`,
      });
    }

    const normalizedLineItems = items.map((item) => ({
      catalogObjectId: String(item.variationId).trim(),
      quantity: String(Number(item.quantity)),
      ...(typeof item?.note === "string" && item.note.trim()
        ? { note: item.note.trim() }
        : {}),
    }));

    const orderPayload = {
      locationId: squareLocationId,
      lineItems: normalizedLineItems,
      fulfillments: [
        {
          type: "PICKUP",
          state: "PROPOSED",
          pickupDetails: {
            recipient: {
              displayName: normalizedCustomerName || "Order for Pickup",
            },
            scheduleType: "ASAP",
          },
        },
      ],
    };

    const taxes = [];

    if (Number.isFinite(stateTaxPercent) && stateTaxPercent > 0) {
      taxes.push({
        uid: "state-tax",
        name: "State Tax",
        percentage: String(stateTaxPercent),
        scope: "ORDER",
      });
    }

    if (Number.isFinite(townTaxPercent) && townTaxPercent > 0) {
      taxes.push({
        uid: "town-tax",
        name: "Town Tax",
        percentage: String(townTaxPercent),
        scope: "ORDER",
      });
    }

    if (taxes.length === 0 && Number.isFinite(salesTaxPercent) && salesTaxPercent > 0) {
      taxes.push({
        uid: "sales-tax",
        name: "Sales Tax",
        percentage: String(salesTaxPercent),
        scope: "ORDER",
      });
    }

    if (taxes.length > 0) {
      orderPayload.taxes = taxes;
    }

    const response = await client.checkout.paymentLinks.create({
      idempotencyKey: crypto.randomUUID(),
      order: orderPayload,
    });

    const url = response?.result?.paymentLink?.url || response?.paymentLink?.url;
    const paymentLinkId = response?.result?.paymentLink?.id || response?.paymentLink?.id || "unknown";
    let orderId = response?.result?.paymentLink?.orderId || response?.paymentLink?.orderId;

    if (!orderId && paymentLinkId && paymentLinkId !== "unknown") {
      try {
        const paymentLinkResponse = await squareRequest(
          `/v2/online-checkout/payment-links/${paymentLinkId}`,
        );
        orderId =
          paymentLinkResponse?.payment_link?.order_id ||
          paymentLinkResponse?.paymentLink?.orderId ||
          orderId;
      } catch (err) {
        console.warn("[checkout] Failed to retrieve payment link order ID:", err.message);
      }
    }

    // If orderId is not in the payment link response, we need to search for it
    if (!orderId) {
      try {
        // The order was created with the idempotency key, search for it by customer name
        const ordersResponse = await client.orders.searchOrders({
          query: {
            filter: {
              locationId: { equalAny: [squareLocationId] },
            },
            sort: {
              sortField: "CREATED_AT",
              sortOrder: "DESC",
            },
          },
          limit: 10,
        });

        // Find the most recent order that matches our customer name
        const recentOrder = ordersResponse?.result?.orders?.find(
          (o) =>
            o.fulfillments?.[0]?.pickupDetails?.recipient?.displayName ===
            (normalizedCustomerName || "Order for Pickup")
        );

        if (recentOrder?.id) {
          orderId = recentOrder.id;
        }
      } catch (err) {
        console.warn("[checkout] Failed to search for order ID:", err.message);
      }
    }

    orderId = orderId || "unknown";

    console.log("[checkout] payment link created", {
      env: process.env.SQUARE_ENVIRONMENT || "sandbox",
      locationId: squareLocationId ? "set" : "missing",
      paymentLinkId,
      orderId,
    });

    if (!url) {
      return res.status(502).json({ error: "Checkout URL not returned" });
    }

    const estimatedTotal = items.reduce(
      (sum, item) => sum + (Number(item?.basePriceMoney?.amount) || 0) * (Number(item?.quantity) || 0),
      0,
    );

    await createTrackedOrder({
      orderId,
      paymentLinkId,
      customerName: normalizedCustomerName || "Guest",
      items: items.map((item) => ({
        name: item.name || "Unknown Item",
        quantity: Number(item.quantity),
        price: item.basePriceMoney?.amount || 0,
        note: typeof item?.note === "string" ? item.note : "",
      })),
      total: estimatedTotal,
    });

    res.json({ url });
  } catch (err) {
    console.error(err);
    const squareDetail =
      err?.body?.errors?.[0]?.detail ||
      err?.result?.errors?.[0]?.detail ||
      err?.message ||
      "Payment failed";
    res.status(500).json({ error: "Payment failed", details: squareDetail });
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`Server running on port ${port}`));