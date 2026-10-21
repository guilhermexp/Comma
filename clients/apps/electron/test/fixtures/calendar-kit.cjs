// A CalendarKit binding that answers like a granted Mac with one calendar.
let listener;
let starts = 0;
const event = JSON.stringify({ error: "calendar_event_not_found" });
module.exports = {
  accessStatus: () => "fullAccess",
  requestAccess: async () => "fullAccess",
  calendars: async () =>
    JSON.stringify({
      calendars: [
        {
          color: "#1badf8",
          id: "cal-1",
          isDefault: true,
          sourceTitle: "On My Mac",
          sourceType: "local",
          title: "Comma Teste",
          writable: true,
        },
      ],
    }),
  events: async (request) =>
    JSON.stringify({ events: [], truncated: JSON.parse(request).limit < 1 }),
  event: async () => event,
  createEvent: async () => JSON.stringify({ error: "calendar_read_only" }),
  updateEvent: async () => event,
  deleteEvent: async () => "{}",
  startObserving: (next) => {
    starts += 1;
    listener = next;
  },
  stopObserving: () => {
    listener = undefined;
  },
  emitChange: () => listener?.(),
  starts: () => starts,
};
