# CalendarKit

This macOS-only Node-API addon gives Electron Main the Mac Calendar through
EventKit. It reads calendars and event occurrences, and it creates, changes and
deletes events. The Agenda uses it through the `calendar.*` native leaves.

It runs inside Comma's own process. macOS grants Calendar access to the app
that calls EventKit, so a helper executable would need its own permission.

## Main-process API

```ts
const addon = loadCalendarKitAddon({ isPackaged: app.isPackaged, logger });
addon.accessStatus();
// "notDetermined" | "denied" | "restricted" | "writeOnly" | "fullAccess" | "unavailable"
await addon.requestAccess();
await addon.calendars();
await addon.events({ calendarIds, start, end, limit });
await addon.event({ eventId, occurrenceDate });
await addon.createEvent({ calendarId, event });
await addon.updateEvent({ eventId, occurrenceDate, scope, patch, targetCalendarId });
await addon.deleteEvent({ eventId, occurrenceDate, scope });
const stop = addon.observeChanges(() => {});
```

Each read and write resolves with its result or with `{ error }`. The codes are
`calendar_access_denied`, `calendar_read_only`, `calendar_event_not_found` and
`calendar_unavailable`. The addon rejects only when the binding is broken.
Requests and results cross the binding as JSON text.

`CalendarService` (`src/main/modules/calendar`) owns the addon in Main. It
applies the C2 limits, logs operation names and error codes only, and groups
change notices into one `revision` step per 500 ms.

## Permission

- On macOS 14 and later, `requestAccess()` calls
  `requestFullAccessToEventsWithCompletion:`. On macOS 13, it calls
  `requestAccessToEntityType:completion:`.
- The prompt appears only while the status is `notDetermined`.
- The bundle must have `NSCalendarsFullAccessUsageDescription` (macOS 14+) and
  `NSCalendarsUsageDescription` (macOS 13). TCC stops a process that asks
  without the text. If the text is missing, the addon answers `unavailable` and
  does not ask.
- The hardened runtime also needs the
  `com.apple.security.personal-information.calendars` entitlement.
- `writeOnly` gives no read access. Main treats it as no access.
- The from-source bundle (`scripts/dev-electron-bundle.ts`) has its own bundle
  id, so it has its own permission. An ad hoc build can ask again after an
  update.

## Identity

- `sourceTitle` is the account title. macOS titles a Google account "Google"
  by default. When a CalDAV account title is not an e-mail and one of its
  calendars is titled with an e-mail (Google's primary calendar), that e-mail
  is the `sourceTitle` of all calendars in the account. The Agenda hides those
  calendars at first when the same Google account is connected through Composio.
- `eventId` is the series' `calendarItemIdentifier`. `eventIdentifier` is not
  used, because it changes on edit and differs between stores.
- A detached occurrence gets a `calendarItemIdentifier` of its own (seen on
  iCloud). It keeps the series' `calendarItemExternalIdentifier`, so the addon
  finds the series through `calendarItemsWithExternalIdentifier:` in the same
  calendar. A `/RID=<seconds since 2001>` suffix is removed from both
  identifiers when it agrees with the occurrence date.
- `occurrenceDate` is the original date of a recurring occurrence. A moved
  occurrence keeps it, and `detached` is `true`.
- `occurrenceId` is `eventId|<original date>`. The date is the day in the
  event's time zone (UTC when it has none) for all-day events, and the UTC
  instant for timed events. A recurring event without an original date uses
  its start, so it does not collapse its series.
- All-day bounds are `YYYY-MM-DD` with an exclusive end, as in Google Calendar.

## Writes

- `instance` changes one occurrence with `EKSpanThisEvent`. The addon finds the
  occurrence with a predicate on the day of `occurrenceDate`, and then on the
  62 days around it for an occurrence that was moved further away. It matches
  the series identity and the original date.
- `series` changes the item from `calendarItemWithIdentifier:` with
  `EKSpanFutureEvents`. That item is the first occurrence, so the change covers
  the whole series. New bounds move the series by the distance they move the
  referenced occurrence. When the series moves in time, EventKit drops its
  detached occurrences, as the Calendar app does. A change without new bounds
  keeps them.
- A simple repetition is an `EKRecurrenceRule` with an interval of 1 and no
  end. Any other rule reads as `custom`. An `instance` write does not change
  the rule.
- A calendar is writable when `allowsContentModifications` is true and
  `immutable` is false. A write to another calendar fails with
  `calendar_read_only` before EventKit saves anything.
- Notes longer than 65,536 characters are cut in results. If the Agenda saves
  the cut text back, the rest is lost.

## Reliability

- All EventKit calls run on one serial queue against one `EKEventStore`.
  Concurrent reads of a store sometimes answer with zero calendars.
- Zero calendars after a non-empty answer is retried. A failed or raising call
  is tried 3 times, 100 ms apart, for an interrupted connection to the
  calendar agent.
- `EKEventStoreChangedNotification` of the shared store is forwarded without
  grouping. Main groups the notices.

## Building

`pnpm build:native` builds it with the rest of the native tree.
`pnpm build:native:calendar-kit` rebuilds only this addon. The binary is
copied to `dist/native/macos/comma-calendar-kit.node`. Forge packages it outside
ASAR through the `dist/native` extra resource. A from-source start builds it
when it is missing (`scripts/dev-native-addons.ts`).
