const OPEN_MINUTES = (7 * 60) + 30;
const CLOSE_MINUTES = (14 * 60) + 15;
const ORDERING_DAYS = new Set(["Tue", "Wed", "Thu", "Fri", "Sat"]);

export const ORDERING_SCHEDULE = Object.freeze({
  days: "Tuesday through Saturday",
  opensAt: "7:30 AM",
  closesAt: "2:15 PM",
});

const getBakeryClock = (value, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(value));

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
};

export const getOrderingScheduleStatus = (
  value = new Date(),
  timeZone = "America/New_York",
) => {
  const { weekday, hour, minute } = getBakeryClock(value, timeZone);
  const currentMinutes = (hour * 60) + minute;
  const isOrderingDay = ORDERING_DAYS.has(weekday);
  const isWithinOrderingWindow =
    isOrderingDay
    && currentMinutes >= OPEN_MINUTES
    && currentMinutes < CLOSE_MINUTES;

  return {
    isWithinOrderingWindow,
    orderingDays: ORDERING_SCHEDULE.days,
    opensAt: ORDERING_SCHEDULE.opensAt,
    closesAt: ORDERING_SCHEDULE.closesAt,
    timeZone,
    message: isWithinOrderingWindow
      ? `Online ordering is open until ${ORDERING_SCHEDULE.closesAt}.`
      : `Online ordering is open ${ORDERING_SCHEDULE.days}, ${ORDERING_SCHEDULE.opensAt}–${ORDERING_SCHEDULE.closesAt}.`,
  };
};
