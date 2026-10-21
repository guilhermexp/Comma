// A CalendarKit binding built before it could write events.
module.exports = {
  accessStatus: () => "fullAccess",
  requestAccess: async () => "fullAccess",
  calendars: async () => JSON.stringify({ calendars: [] }),
  events: async () => JSON.stringify({ events: [], truncated: false }),
};
