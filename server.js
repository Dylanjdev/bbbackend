import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import square from "square";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

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

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
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

app.post("/create-checkout", async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN || !squareLocationId) {
      return res.status(500).json({ error: "Missing Square backend configuration" });
    }

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const hasInvalidItems = items.some((item) => {
      const variationId =
        typeof item?.variationId === "string" ? item.variationId.trim() : "";
      const quantity = Number(item?.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return true;
      }

      if (variationId) {
        return false;
      }

      const amount = item?.basePriceMoney?.amount;
      return (
        !item?.name ||
        !Number.isInteger(amount) ||
        amount <= 0
      );
    });

    if (hasInvalidItems) {
      return res.status(400).json({ error: "Invalid cart items" });
    }

    const normalizedLineItems = items.map((item) => {
      const variationId =
        typeof item?.variationId === "string" ? item.variationId.trim() : "";

      if (variationId) {
        return {
          catalogObjectId: variationId,
          quantity: String(Number(item.quantity)),
        };
      }

      return {
        name: item.name,
        quantity: String(Number(item.quantity)),
        basePriceMoney: {
          amount: BigInt(item.basePriceMoney.amount),
          currency: item?.basePriceMoney?.currency || "USD",
        },
      };
    });

    const orderPayload = {
      locationId: squareLocationId,
      lineItems: normalizedLineItems,
      fulfillments: [
        {
          type: "PICKUP",
          state: "PROPOSED",
          pickupDetails: {
            recipient: {
              displayName: "Order for Pickup",
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
    const orderId = response?.result?.paymentLink?.orderId || response?.paymentLink?.orderId || "unknown";

    console.log("[checkout] payment link created", {
      env: process.env.SQUARE_ENVIRONMENT || "sandbox",
      locationId: squareLocationId ? "set" : "missing",
      paymentLinkId,
      orderId,
    });

    if (!url) {
      return res.status(502).json({ error: "Checkout URL not returned" });
    }
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