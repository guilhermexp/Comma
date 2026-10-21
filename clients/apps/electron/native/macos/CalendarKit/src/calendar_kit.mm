#include <node_api.h>

#import <AppKit/AppKit.h>
#import <EventKit/EventKit.h>
#import <Foundation/Foundation.h>

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

// The Mac Calendar for Comma's Main process. Every EventKit call runs on one
// serial queue against one EKEventStore: concurrent reads of the same store
// sometimes answer with zero calendars. Requests and results cross the
// binding as JSON text; a result is either the value or `{ "error": code }`.

namespace {

dispatch_queue_t gQueue = nullptr;
EKEventStore *gStore = nil;
NSUInteger gLastCalendarCount = 0;
id gObserver = nil;
napi_threadsafe_function gChangeListener = nullptr;

NSString *const kAccessDenied = @"calendar_access_denied";
NSString *const kReadOnly = @"calendar_read_only";
NSString *const kNotFound = @"calendar_event_not_found";
NSString *const kUnavailable = @"calendar_unavailable";

const NSUInteger kTitleMax = 4096;
const NSUInteger kLocationMax = 4096;
const NSUInteger kNotesMax = 65536;
const NSUInteger kUrlMax = 8192;
const NSTimeInterval kDay = 24 * 60 * 60;

dispatch_queue_t Queue() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gQueue = dispatch_queue_create("surf.comma.calendar-kit", DISPATCH_QUEUE_SERIAL);
  });
  return gQueue;
}

// Only ever touched on Queue().
EKEventStore *Store() {
  if (gStore == nil) gStore = [[EKEventStore alloc] init];
  return gStore;
}

// --- Promises -------------------------------------------------------------

struct PendingCall {
  napi_deferred deferred = nullptr;
  napi_threadsafe_function settle = nullptr;
};

void SettleOnJsThread(napi_env env, napi_value, void *context, void *data) {
  auto *call = static_cast<PendingCall *>(context);
  auto *text = static_cast<char *>(data);
  if (env != nullptr) {
    napi_value value = nullptr;
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, call->deferred, value);
  }
  free(text);
  delete call;
}

typedef void (^Done)(NSString *text);

// Creates a promise that `work` settles from any thread through `done`.
napi_value Async(napi_env env, void (^work)(Done done)) {
  auto *call = new PendingCall();
  napi_value promise = nullptr;
  napi_create_promise(env, &call->deferred, &promise);
  napi_value resource_name = nullptr;
  napi_create_string_utf8(env, "comma_calendar_kit", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_threadsafe_function(env, nullptr, nullptr, resource_name, 0, 1, nullptr,
                                  nullptr, call, SettleOnJsThread, &call->settle);
  napi_threadsafe_function settle = call->settle;
  Done done = ^(NSString *text) {
    napi_call_threadsafe_function(settle, strdup(text.UTF8String), napi_tsfn_blocking);
    napi_release_threadsafe_function(settle, napi_tsfn_release);
  };
  dispatch_async(Queue(), ^{
    work(done);
  });
  return promise;
}

NSString *Json(id object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (data == nil) return @"{\"error\":\"calendar_unavailable\"}";
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

NSString *ErrorJson(NSString *code) { return Json(@{@"error" : code}); }

NSDictionary *ReadRequest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return nil;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok) return nil;
  char *buffer = static_cast<char *>(malloc(length + 1));
  napi_get_value_string_utf8(env, argv[0], buffer, length + 1, &length);
  NSData *data = [NSData dataWithBytesNoCopy:buffer length:length freeWhenDone:YES];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

NSString *StringField(NSDictionary *object, NSString *key) {
  id value = object[key];
  return [value isKindOfClass:[NSString class]] ? value : nil;
}

BOOL HasField(NSDictionary *object, NSString *key) { return object[key] != nil; }

// --- Retry ----------------------------------------------------------------

// EventKit talks to calendaragent over XPC; an interrupted connection raises
// or answers nil once and then recovers. Three tries 100 ms apart.
id WithRetry(id (^attempt)(void)) {
  for (int tries = 0; tries < 3; tries += 1) {
    if (tries > 0) usleep(100 * 1000);
    @try {
      id result = attempt();
      if (result != nil) return result;
    } @catch (NSException *) {
    }
  }
  return nil;
}

// --- Access ---------------------------------------------------------------

NSString *AccessName(EKAuthorizationStatus status) {
  // Raw values: macOS 14 renamed 3 (Authorized) to FullAccess and added 4.
  switch (static_cast<NSInteger>(status)) {
    case 0:
      return @"notDetermined";
    case 1:
      return @"restricted";
    case 2:
      return @"denied";
    case 3:
      return @"fullAccess";
    case 4:
      return @"writeOnly";
    default:
      return @"denied";
  }
}

// Calendar access is tracked per bundle; without one (a bare node) there is
// nothing to ask for.
BOOL HasBundle() { return [[NSBundle mainBundle] bundleIdentifier] != nil; }

NSString *CurrentAccess() {
  if (!HasBundle()) return @"unavailable";
  return AccessName([EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent]);
}

BOOL HasFullAccess() { return [CurrentAccess() isEqualToString:@"fullAccess"]; }

// TCC terminates a process that asks without the usage text, so a bundle that
// lacks it (an unprepared dev bundle) answers `unavailable` instead.
BOOL HasUsageDescription() {
  NSString *key = @"NSCalendarsUsageDescription";
  if (@available(macOS 14.0, *)) key = @"NSCalendarsFullAccessUsageDescription";
  return [[NSBundle mainBundle] objectForInfoDictionaryKey:key] != nil;
}

// --- Values ---------------------------------------------------------------

NSString *Clip(NSString *text, NSUInteger max) {
  if (text == nil) return nil;
  if (text.length <= max) return text;
  NSRange range = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, max)];
  if (range.length > max) range = [text rangeOfComposedCharacterSequenceAtIndex:max - 1];
  return [text substringToIndex:MIN(range.location, max)];
}

id OrNull(id value) { return value != nil ? value : [NSNull null]; }

NSString *InstantString(NSDate *date) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.timeZone = [NSTimeZone localTimeZone];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter stringFromDate:date];
}

NSString *UtcInstantString(NSDate *date) {
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter stringFromDate:date];
}

NSDate *ParseInstant(NSString *text) {
  if (text == nil) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  NSDate *date = [formatter dateFromString:text];
  if (date != nil) return date;
  formatter.formatOptions =
      NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  return [formatter dateFromString:text];
}

NSCalendar *CalendarIn(NSTimeZone *zone) {
  NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  calendar.timeZone = zone ?: [NSTimeZone localTimeZone];
  return calendar;
}

NSString *DateString(NSDate *date, NSTimeZone *zone) {
  NSDateComponents *parts = [CalendarIn(zone) components:NSCalendarUnitYear | NSCalendarUnitMonth |
                                                         NSCalendarUnitDay
                                                fromDate:date];
  return [NSString stringWithFormat:@"%04ld-%02ld-%02ld", (long)parts.year, (long)parts.month,
                                    (long)parts.day];
}

// `YYYY-MM-DD` as local midnight, where EventKit keeps floating all-day dates.
NSDate *ParseDate(NSString *text) {
  NSArray<NSString *> *parts = [text componentsSeparatedByString:@"-"];
  if (parts.count != 3) return nil;
  NSDateComponents *components = [[NSDateComponents alloc] init];
  components.year = parts[0].integerValue;
  components.month = parts[1].integerValue;
  components.day = parts[2].integerValue;
  return [CalendarIn(nil) dateFromComponents:components];
}

BOOL SameInstant(NSDate *left, NSDate *right) {
  return left != nil && right != nil && fabs([left timeIntervalSinceDate:right]) < 1;
}

NSString *ColorHex(NSColor *color) {
  NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
  if (rgb == nil) return @"#8e8e93";
  auto channel = [](CGFloat value) {
    return static_cast<int>(lround(fmin(fmax(value, 0), 1) * 255));
  };
  return [NSString stringWithFormat:@"#%02x%02x%02x", channel(rgb.redComponent),
                                    channel(rgb.greenComponent), channel(rgb.blueComponent)];
}

NSString *SourceType(EKSourceType type) {
  switch (type) {
    case EKSourceTypeLocal:
      return @"local";
    case EKSourceTypeExchange:
      return @"exchange";
    case EKSourceTypeCalDAV:
      return @"calDAV";
    case EKSourceTypeMobileMe:
      return @"mobileMe";
    case EKSourceTypeSubscribed:
      return @"subscribed";
    case EKSourceTypeBirthdays:
      return @"birthdays";
    default:
      return @"unknown";
  }
}

BOOL Writable(EKCalendar *calendar) {
  return calendar.allowsContentModifications && !calendar.isImmutable;
}

// --- Identity -------------------------------------------------------------

BOOL IsRecurring(EKEvent *event) { return event.hasRecurrenceRules || event.isDetached; }

// EventKit names a detached occurrence `<series>/RID=<seconds since 2001>`.
// Only a suffix that agrees with the occurrence date is stripped.
NSString *WithoutOccurrenceSuffix(NSString *identifier, EKEvent *event) {
  if (identifier == nil || !IsRecurring(event) || event.occurrenceDate == nil) return identifier;
  NSString *suffix =
      [NSString stringWithFormat:@"/RID=%lld",
                                 llround(event.occurrenceDate.timeIntervalSinceReferenceDate)];
  return [identifier hasSuffix:suffix]
             ? [identifier substringToIndex:identifier.length - suffix.length]
             : identifier;
}

// The series identity: the series' `calendarItemIdentifier`. `eventIdentifier`
// is not used: it changes on edit and differs between stores. A detached
// occurrence gets an item identifier of its own and keeps only the series'
// external identifier, so its series is found through that.
NSString *SeriesId(EKEvent *event) {
  NSString *own = WithoutOccurrenceSuffix(event.calendarItemIdentifier, event);
  if (!event.isDetached) return own;
  NSString *external = WithoutOccurrenceSuffix(event.calendarItemExternalIdentifier, event);
  if (external.length == 0) return own;
  NSString *calendarId = event.calendar.calendarIdentifier;
  NSArray *items = WithRetry(^id {
    return [Store() calendarItemsWithExternalIdentifier:external];
  });
  for (id item in items) {
    if (![item isKindOfClass:[EKEvent class]]) continue;
    EKEvent *candidate = item;
    if (!candidate.isDetached && candidate.hasRecurrenceRules &&
        [candidate.calendar.calendarIdentifier isEqualToString:calendarId]) {
      return candidate.calendarItemIdentifier;
    }
  }
  return own;
}

NSString *OccurrenceKey(EKEvent *event) {
  NSDate *original = event.occurrenceDate;
  if (event.isAllDay) {
    NSTimeZone *zone = event.timeZone ?: [NSTimeZone timeZoneForSecondsFromGMT:0];
    return DateString(original, zone);
  }
  return UtcInstantString(original);
}

NSString *OccurrenceId(EKEvent *event) {
  NSString *series = SeriesId(event);
  if (!IsRecurring(event)) return series;
  // A recurring event without an original date must not collapse its series.
  if (event.occurrenceDate == nil) {
    return [NSString stringWithFormat:@"%@|start:%@", series, UtcInstantString(event.startDate)];
  }
  return [NSString stringWithFormat:@"%@|%@", series, OccurrenceKey(event)];
}

// --- Recurrence -----------------------------------------------------------

NSString *FrequencyName(EKRecurrenceFrequency frequency) {
  switch (frequency) {
    case EKRecurrenceFrequencyDaily:
      return @"daily";
    case EKRecurrenceFrequencyWeekly:
      return @"weekly";
    case EKRecurrenceFrequencyMonthly:
      return @"monthly";
    case EKRecurrenceFrequencyYearly:
      return @"yearly";
  }
  return @"custom";
}

// A simple rule repeats every period with no end and no extra selectors. A
// selector that only restates the start (weekly on its own weekday, monthly
// on its own day) is still simple.
NSString *Classify(NSArray<EKRecurrenceRule *> *rules, NSDate *start) {
  if (rules.count == 0) return @"none";
  if (rules.count != 1) return @"custom";
  EKRecurrenceRule *rule = rules.firstObject;
  if (rule.interval != 1 || rule.recurrenceEnd != nil || rule.daysOfTheYear.count > 0 ||
      rule.weeksOfTheYear.count > 0 || rule.monthsOfTheYear.count > 1 ||
      rule.setPositions.count > 0) {
    return @"custom";
  }
  NSCalendar *calendar = CalendarIn(nil);
  if (rule.daysOfTheWeek.count > 0) {
    EKRecurrenceDayOfWeek *day = rule.daysOfTheWeek.firstObject;
    if (rule.frequency != EKRecurrenceFrequencyWeekly || rule.daysOfTheWeek.count != 1 ||
        day.weekNumber != 0 ||
        day.dayOfTheWeek != [calendar component:NSCalendarUnitWeekday fromDate:start]) {
      return @"custom";
    }
  }
  if (rule.daysOfTheMonth.count > 0) {
    if (rule.frequency == EKRecurrenceFrequencyDaily ||
        rule.frequency == EKRecurrenceFrequencyWeekly || rule.daysOfTheMonth.count != 1 ||
        rule.daysOfTheMonth.firstObject.integerValue !=
            [calendar component:NSCalendarUnitDay fromDate:start]) {
      return @"custom";
    }
  }
  if (rule.monthsOfTheYear.count == 1 &&
      (rule.frequency != EKRecurrenceFrequencyYearly ||
       rule.monthsOfTheYear.firstObject.integerValue !=
           [calendar component:NSCalendarUnitMonth fromDate:start])) {
    return @"custom";
  }
  return FrequencyName(rule.frequency);
}

EKRecurrenceRule *SimpleRule(NSString *recurrence) {
  EKRecurrenceFrequency frequency;
  if ([recurrence isEqualToString:@"daily"]) {
    frequency = EKRecurrenceFrequencyDaily;
  } else if ([recurrence isEqualToString:@"weekly"]) {
    frequency = EKRecurrenceFrequencyWeekly;
  } else if ([recurrence isEqualToString:@"monthly"]) {
    frequency = EKRecurrenceFrequencyMonthly;
  } else if ([recurrence isEqualToString:@"yearly"]) {
    frequency = EKRecurrenceFrequencyYearly;
  } else {
    return nil;
  }
  return [[EKRecurrenceRule alloc] initRecurrenceWithFrequency:frequency interval:1 end:nil];
}

// --- Fetching -------------------------------------------------------------

NSArray<EKCalendar *> *FetchCalendars() {
  NSArray<EKCalendar *> *calendars = nil;
  // Zero calendars right after a non-empty answer is the store racing itself.
  for (int tries = 0; tries < 3; tries += 1) {
    if (tries > 0) usleep(100 * 1000);
    calendars = WithRetry(^id {
      return [Store() calendarsForEntityType:EKEntityTypeEvent];
    });
    if (calendars.count > 0 || gLastCalendarCount == 0) break;
  }
  if (calendars == nil) return nil;
  gLastCalendarCount = calendars.count;
  return calendars;
}

NSArray<EKEvent *> *EventsBetween(NSDate *start, NSDate *end, NSArray<EKCalendar *> *calendars) {
  return WithRetry(^id {
    NSPredicate *predicate = [Store() predicateForEventsWithStartDate:start
                                                              endDate:end
                                                            calendars:calendars];
    return [[Store() eventsMatchingPredicate:predicate]
        sortedArrayUsingSelector:@selector(compareStartDateWithEvent:)];
  });
}

EKEvent *CalendarItem(NSString *identifier) {
  if (identifier == nil) return nil;
  id item = WithRetry(^id {
    return [Store() calendarItemWithIdentifier:identifier];
  });
  return [item isKindOfClass:[EKEvent class]] ? item : nil;
}

EKEvent *MatchOccurrence(NSArray<EKEvent *> *events, NSString *seriesId, NSDate *original) {
  for (EKEvent *event in events) {
    if ([SeriesId(event) isEqualToString:seriesId] && SameInstant(event.occurrenceDate, original)) {
      return event;
    }
  }
  return nil;
}

// One occurrence: searched on the day of its original date, then, for an
// occurrence moved further away, across the 62 days around it.
EKEvent *FindOccurrence(NSString *seriesId, NSDate *original) {
  NSDate *day = [CalendarIn(nil) startOfDayForDate:original];
  EKEvent *found = MatchOccurrence(
      EventsBetween(day, [day dateByAddingTimeInterval:kDay], nil), seriesId, original);
  if (found != nil) return found;
  return MatchOccurrence(EventsBetween([day dateByAddingTimeInterval:-31 * kDay],
                                       [day dateByAddingTimeInterval:32 * kDay], nil),
                         seriesId, original);
}

EKEvent *Resolve(NSDictionary *request) {
  NSString *eventId = StringField(request, @"eventId");
  NSString *occurrence = StringField(request, @"occurrenceDate");
  if (occurrence == nil) return CalendarItem(eventId);
  NSDate *original = ParseInstant(occurrence);
  return original != nil ? FindOccurrence(eventId, original) : nil;
}

// --- Mapping --------------------------------------------------------------

BOOL IsEmail(NSString *text) {
  NSRange at = [text rangeOfString:@"@"];
  return at.location != NSNotFound && at.location > 0 && at.location + 1 < text.length &&
         [text rangeOfCharacterFromSet:NSCharacterSet.whitespaceCharacterSet].location == NSNotFound &&
         [[text substringFromIndex:at.location + 1] containsString:@"."];
}

// The account a calendar belongs to. macOS titles a Google account "Google"
// by default, but its primary calendar is titled with the account's e-mail,
// which the Agenda needs to hide calendars it also reads through Composio.
NSDictionary<NSString *, NSString *> *SourceTitles(NSArray<EKCalendar *> *calendars) {
  NSMutableDictionary<NSString *, NSString *> *titles = [NSMutableDictionary dictionary];
  for (EKCalendar *calendar in calendars) {
    EKSource *source = calendar.source;
    if (source.sourceIdentifier == nil) continue;
    if (titles[source.sourceIdentifier] == nil) titles[source.sourceIdentifier] = source.title ?: @"";
    if (source.sourceType == EKSourceTypeCalDAV && !IsEmail(source.title ?: @"") &&
        IsEmail(calendar.title ?: @"") && !IsEmail(titles[source.sourceIdentifier])) {
      titles[source.sourceIdentifier] = calendar.title;
    }
  }
  return titles;
}

NSDictionary *CalendarJson(EKCalendar *calendar, EKCalendar *defaultCalendar,
                           NSDictionary<NSString *, NSString *> *sourceTitles) {
  NSString *sourceTitle =
      (calendar.source.sourceIdentifier ? sourceTitles[calendar.source.sourceIdentifier] : nil)
          ?: calendar.source.title;
  return @{
    @"color" : ColorHex(calendar.color),
    @"id" : calendar.calendarIdentifier,
    @"isDefault" : @([calendar.calendarIdentifier
        isEqualToString:defaultCalendar.calendarIdentifier ?: @""]),
    @"sourceTitle" : Clip(sourceTitle ?: @"", 1024),
    @"sourceType" : SourceType(calendar.source.sourceType),
    @"title" : Clip(calendar.title ?: @"", 1024),
    @"writable" : @(Writable(calendar)),
  };
}

NSDictionary *EventJson(EKEvent *event, NSMutableDictionary<NSString *, NSString *> *seriesRules) {
  NSString *start;
  NSString *end;
  if (event.isAllDay) {
    // All-day ends are exclusive, as in Google Calendar; EventKit keeps the
    // last second of the last day.
    NSDate *lastDay = [CalendarIn(nil) startOfDayForDate:event.endDate];
    NSDate *firstDay = [CalendarIn(nil) startOfDayForDate:event.startDate];
    if ([lastDay compare:firstDay] == NSOrderedAscending) lastDay = firstDay;
    start = DateString(firstDay, nil);
    end = DateString([CalendarIn(nil) dateByAddingUnit:NSCalendarUnitDay
                                                 value:1
                                                toDate:lastDay
                                               options:0],
                     nil);
  } else {
    start = InstantString(event.startDate);
    end = InstantString(event.endDate);
  }

  NSString *seriesId = SeriesId(event);
  NSString *recurrence;
  if (event.hasRecurrenceRules) {
    recurrence = Classify(event.recurrenceRules, event.startDate);
  } else if (event.isDetached) {
    // A detached occurrence carries no rule of its own; its series does.
    recurrence = seriesRules[seriesId];
    if (recurrence == nil) {
      EKEvent *series = CalendarItem(seriesId);
      recurrence = series != nil ? Classify(series.recurrenceRules, series.startDate) : @"custom";
      if ([recurrence isEqualToString:@"none"]) recurrence = @"custom";
      seriesRules[seriesId] = recurrence;
    }
  } else {
    recurrence = @"none";
  }

  BOOL recurring = IsRecurring(event);
  return @{
    @"allDay" : @(event.isAllDay),
    @"calendarId" : event.calendar.calendarIdentifier ?: @"",
    @"detached" : @(event.isDetached),
    @"editable" : @(Writable(event.calendar)),
    @"end" : end,
    @"eventId" : seriesId ?: @"",
    @"externalId" : OrNull(Clip(
        WithoutOccurrenceSuffix(event.calendarItemExternalIdentifier, event), 1024)),
    @"location" : OrNull(Clip(event.location.length > 0 ? event.location : nil, kLocationMax)),
    @"notes" : OrNull(Clip(event.hasNotes ? event.notes : nil, kNotesMax)),
    @"occurrenceDate" : recurring && event.occurrenceDate != nil
        ? InstantString(event.occurrenceDate)
        : [NSNull null],
    @"occurrenceId" : OccurrenceId(event),
    @"recurrence" : recurrence,
    @"start" : start,
    @"title" : Clip(event.title ?: @"", kTitleMax),
    @"url" : OrNull(Clip(event.URL.absoluteString, kUrlMax)),
  };
}

NSString *SaveErrorCode(NSError *error) {
  if ([error.domain isEqualToString:EKErrorDomain]) {
    switch (error.code) {
      case EKErrorCalendarReadOnly:
      case EKErrorCalendarIsImmutable:
      case EKErrorCalendarDoesNotAllowEvents:
      case EKErrorEventNotMutable:
        return kReadOnly;
      case EKErrorObjectBelongsToDifferentStore:
      case EKErrorEventStoreNotAuthorized:
        return kAccessDenied;
      default:
        break;
    }
  }
  return kUnavailable;
}

// --- Writing --------------------------------------------------------------

// Moving "all" from a later occurrence: the series' first date moves by the
// days that occurrence moved and takes its new time of day and duration, as
// the Google source does. The first date never becomes the dragged one.
NSDate *SeriesStart(NSDate *seriesStart, NSDate *from, NSDate *to, NSTimeZone *zone) {
  NSCalendar *calendar = CalendarIn(zone);
  NSInteger days = [calendar components:NSCalendarUnitDay
                               fromDate:[calendar startOfDayForDate:from]
                                 toDate:[calendar startOfDayForDate:to]
                                options:0]
                       .day;
  NSDate *day = [calendar dateByAddingUnit:NSCalendarUnitDay
                                     value:days
                                    toDate:[calendar startOfDayForDate:seriesStart]
                                   options:0];
  NSDateComponents *time = [calendar components:NSCalendarUnitHour | NSCalendarUnitMinute |
                                                NSCalendarUnitSecond
                                       fromDate:to];
  return [calendar dateBySettingHour:time.hour
                              minute:time.minute
                              second:time.second
                              ofDate:day
                             options:0];
}

// Applies the fields an input or patch names. With `shiftFrom`, new bounds
// move the target as SeriesStart describes, so editing "all" from a later
// occurrence keeps the series anchored on its first one.
BOOL ApplyFields(EKEvent *event, NSDictionary *fields, EKEvent *shiftFrom, BOOL applyRecurrence) {
  if (HasField(fields, @"title")) event.title = StringField(fields, @"title") ?: @"";
  if (HasField(fields, @"location")) event.location = StringField(fields, @"location");
  if (HasField(fields, @"description")) event.notes = StringField(fields, @"description");

  BOOL allDay = event.isAllDay;
  if (HasField(fields, @"allDay")) allDay = [fields[@"allDay"] boolValue];
  if (allDay != event.isAllDay) event.allDay = allDay;

  NSString *startText = StringField(fields, @"start");
  NSString *endText = StringField(fields, @"end");
  NSDate *start = startText == nil ? nil : allDay ? ParseDate(startText) : ParseInstant(startText);
  NSDate *end = endText == nil ? nil : allDay ? ParseDate(endText) : ParseInstant(endText);
  if ((startText != nil && start == nil) || (endText != nil && end == nil)) return NO;
  // An exclusive all-day end becomes the last day EventKit stores.
  if (allDay && end != nil) end = [end dateByAddingTimeInterval:-1];

  if (shiftFrom != nil && start != nil) {
    NSTimeZone *zone = allDay ? nil
                              : [NSTimeZone timeZoneWithName:StringField(fields, @"timeZone") ?: @""]
                                    ?: event.timeZone;
    NSTimeInterval duration = end != nil ? [end timeIntervalSinceDate:start]
                                         : [event.endDate timeIntervalSinceDate:event.startDate];
    start = SeriesStart(event.startDate, shiftFrom.startDate, start, zone);
    end = [start dateByAddingTimeInterval:duration];
  } else if (shiftFrom != nil && end != nil) {
    end = [event.endDate dateByAddingTimeInterval:[end timeIntervalSinceDate:shiftFrom.endDate]];
  }
  if (start != nil) event.startDate = start;
  if (end != nil) event.endDate = end;

  if (allDay) {
    event.timeZone = nil;
  } else if (HasField(fields, @"timeZone")) {
    event.timeZone = [NSTimeZone timeZoneWithName:StringField(fields, @"timeZone")]
                         ?: [NSTimeZone localTimeZone];
  }

  if (applyRecurrence && HasField(fields, @"recurrence")) {
    for (EKRecurrenceRule *rule in [event.recurrenceRules copy]) [event removeRecurrenceRule:rule];
    EKRecurrenceRule *rule = SimpleRule(StringField(fields, @"recurrence"));
    if (rule != nil) [event addRecurrenceRule:rule];
  }
  return YES;
}

// --- Exports --------------------------------------------------------------

napi_value AccessStatus(napi_env env, napi_callback_info) {
  napi_value value = nullptr;
  napi_create_string_utf8(env, CurrentAccess().UTF8String, NAPI_AUTO_LENGTH, &value);
  return value;
}

napi_value RequestAccess(napi_env env, napi_callback_info) {
  return Async(env, ^(Done done) {
    if (!HasBundle() || !HasUsageDescription()) {
      done(@"unavailable");
      return;
    }
    EKEventStore *store = Store();
    void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *) {
      dispatch_async(Queue(), ^{
        // Calendars granted after the store was made appear after a reset.
        if (granted) [Store() reset];
        done(CurrentAccess());
      });
    };
    if (@available(macOS 14.0, *)) {
      [store requestFullAccessToEventsWithCompletion:completion];
    } else {
      [store requestAccessToEntityType:EKEntityTypeEvent completion:completion];
    }
  });
}

napi_value Calendars(napi_env env, napi_callback_info) {
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    NSArray<EKCalendar *> *calendars = FetchCalendars();
    if (calendars == nil) return done(ErrorJson(kUnavailable));
    EKCalendar *defaultCalendar = Store().defaultCalendarForNewEvents;
    NSDictionary<NSString *, NSString *> *sourceTitles = SourceTitles(calendars);
    NSMutableArray *result = [NSMutableArray arrayWithCapacity:calendars.count];
    for (EKCalendar *calendar in calendars) {
      [result addObject:CalendarJson(calendar, defaultCalendar, sourceTitles)];
    }
    done(Json(@{@"calendars" : result}));
  });
}

napi_value Events(napi_env env, napi_callback_info info) {
  NSDictionary *request = ReadRequest(env, info);
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    NSDate *start = ParseInstant(StringField(request, @"start"));
    NSDate *end = ParseInstant(StringField(request, @"end"));
    NSArray *ids = request[@"calendarIds"];
    NSInteger limit = [request[@"limit"] integerValue];
    if (start == nil || end == nil || ![ids isKindOfClass:[NSArray class]] || limit <= 0) {
      return done(ErrorJson(kUnavailable));
    }
    NSArray<EKCalendar *> *all = FetchCalendars();
    if (all == nil) return done(ErrorJson(kUnavailable));
    NSSet *wanted = [NSSet setWithArray:ids];
    NSMutableArray<EKCalendar *> *calendars = [NSMutableArray array];
    for (EKCalendar *calendar in all) {
      if ([wanted containsObject:calendar.calendarIdentifier]) [calendars addObject:calendar];
    }
    // A nil calendar list would mean every calendar.
    if (calendars.count == 0) return done(Json(@{@"events" : @[], @"truncated" : @NO}));
    NSArray<EKEvent *> *events = EventsBetween(start, end, calendars);
    if (events == nil) return done(ErrorJson(kUnavailable));
    NSMutableArray *result = [NSMutableArray array];
    NSMutableDictionary *seriesRules = [NSMutableDictionary dictionary];
    for (EKEvent *event in events) {
      if (result.count >= static_cast<NSUInteger>(limit)) break;
      [result addObject:EventJson(event, seriesRules)];
    }
    done(Json(@{
      @"events" : result,
      @"truncated" : @(events.count > static_cast<NSUInteger>(limit)),
    }));
  });
}

napi_value Event(napi_env env, napi_callback_info info) {
  NSDictionary *request = ReadRequest(env, info);
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    EKEvent *event = Resolve(request);
    if (event == nil) return done(ErrorJson(kNotFound));
    done(Json(EventJson(event, [NSMutableDictionary dictionary])));
  });
}

napi_value CreateEvent(napi_env env, napi_callback_info info) {
  NSDictionary *request = ReadRequest(env, info);
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    EKCalendar *calendar = [Store() calendarWithIdentifier:StringField(request, @"calendarId")];
    NSDictionary *input = request[@"event"];
    if (calendar == nil || ![input isKindOfClass:[NSDictionary class]]) {
      return done(ErrorJson(kUnavailable));
    }
    if (!Writable(calendar)) return done(ErrorJson(kReadOnly));
    EKEvent *event = [EKEvent eventWithEventStore:Store()];
    event.calendar = calendar;
    if (!ApplyFields(event, input, nil, YES)) return done(ErrorJson(kUnavailable));
    NSError *error = nil;
    BOOL saved = NO;
    @try {
      saved = [Store() saveEvent:event span:EKSpanThisEvent commit:YES error:&error];
    } @catch (NSException *) {
    }
    if (!saved) return done(ErrorJson(error ? SaveErrorCode(error) : kUnavailable));
    done(Json(EventJson(event, [NSMutableDictionary dictionary])));
  });
}

// The item a write acts on: the occurrence for "instance", the series' first
// occurrence for "series". `occurrence` is the referenced one, when given.
EKEvent *WriteTarget(NSDictionary *request, BOOL series, EKEvent **occurrence) {
  EKEvent *referenced = Resolve(request);
  *occurrence = StringField(request, @"occurrenceDate") != nil ? referenced : nil;
  if (!series) return referenced;
  return CalendarItem(StringField(request, @"eventId")) ?: referenced;
}

napi_value UpdateEvent(napi_env env, napi_callback_info info) {
  NSDictionary *request = ReadRequest(env, info);
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    BOOL series = [StringField(request, @"scope") isEqualToString:@"series"];
    NSDictionary *patch = request[@"patch"];
    if (![patch isKindOfClass:[NSDictionary class]]) return done(ErrorJson(kUnavailable));
    EKEvent *occurrence = nil;
    EKEvent *target = WriteTarget(request, series, &occurrence);
    if (target == nil) return done(ErrorJson(kNotFound));
    if (!Writable(target.calendar)) return done(ErrorJson(kReadOnly));

    NSString *targetCalendarId = StringField(request, @"targetCalendarId");
    if (targetCalendarId != nil &&
        ![targetCalendarId isEqualToString:target.calendar.calendarIdentifier]) {
      EKCalendar *calendar = [Store() calendarWithIdentifier:targetCalendarId];
      if (calendar == nil) return done(ErrorJson(kUnavailable));
      if (!Writable(calendar)) return done(ErrorJson(kReadOnly));
      target.calendar = calendar;
    }

    BOOL seriesWrite = series && IsRecurring(target);
    EKEvent *shiftFrom = seriesWrite && occurrence != nil && occurrence != target ? occurrence : nil;
    // "Only this" cannot change the rule of the series it belongs to.
    if (!ApplyFields(target, patch, shiftFrom, seriesWrite || !IsRecurring(target))) {
      return done(ErrorJson(kUnavailable));
    }
    NSError *error = nil;
    BOOL saved = NO;
    @try {
      saved = [Store() saveEvent:target
                            span:seriesWrite ? EKSpanFutureEvents : EKSpanThisEvent
                          commit:YES
                           error:&error];
    } @catch (NSException *) {
    }
    if (!saved) return done(ErrorJson(error ? SaveErrorCode(error) : kUnavailable));
    done(Json(EventJson(target, [NSMutableDictionary dictionary])));
  });
}

napi_value DeleteEvent(napi_env env, napi_callback_info info) {
  NSDictionary *request = ReadRequest(env, info);
  return Async(env, ^(Done done) {
    if (!HasFullAccess()) return done(ErrorJson(kAccessDenied));
    BOOL series = [StringField(request, @"scope") isEqualToString:@"series"];
    EKEvent *occurrence = nil;
    EKEvent *target = WriteTarget(request, series, &occurrence);
    if (target == nil) return done(ErrorJson(kNotFound));
    if (!Writable(target.calendar)) return done(ErrorJson(kReadOnly));
    NSError *error = nil;
    BOOL removed = NO;
    @try {
      removed = [Store() removeEvent:target
                                span:series && IsRecurring(target) ? EKSpanFutureEvents
                                                                   : EKSpanThisEvent
                              commit:YES
                               error:&error];
    } @catch (NSException *) {
    }
    if (!removed) return done(ErrorJson(error ? SaveErrorCode(error) : kUnavailable));
    done(@"{}");
  });
}

void ReleaseChangeListener() {
  if (gObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:gObserver];
    gObserver = nil;
  }
  if (gChangeListener != nullptr) {
    napi_release_threadsafe_function(gChangeListener, napi_tsfn_release);
    gChangeListener = nullptr;
  }
}

// Forwards every EKEventStoreChangedNotification of the shared store, from
// this app or any other, to `listener`. Main coalesces them.
napi_value StartObserving(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "startObserving expects a listener");
    return nullptr;
  }
  ReleaseChangeListener();
  napi_value resource_name = nullptr;
  napi_create_string_utf8(env, "comma_calendar_kit_changes", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_threadsafe_function(env, argv[0], nullptr, resource_name, 0, 1, nullptr, nullptr,
                                  nullptr, nullptr, &gChangeListener);
  // Watching must not keep Main alive on its own.
  napi_unref_threadsafe_function(env, gChangeListener);
  __block EKEventStore *store = nil;
  dispatch_sync(Queue(), ^{
    store = Store();
  });
  napi_threadsafe_function listener = gChangeListener;
  gObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:EKEventStoreChangedNotification
                  object:store
                   queue:nil
              usingBlock:^(NSNotification *) {
                napi_call_threadsafe_function(listener, nullptr, napi_tsfn_nonblocking);
              }];
  return nullptr;
}

napi_value StopObserving(napi_env, napi_callback_info) {
  ReleaseChangeListener();
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  const struct {
    const char *name;
    napi_callback callback;
  } methods[] = {
      {"accessStatus", AccessStatus},   {"requestAccess", RequestAccess},
      {"calendars", Calendars},         {"events", Events},
      {"event", Event},                 {"createEvent", CreateEvent},
      {"updateEvent", UpdateEvent},     {"deleteEvent", DeleteEvent},
      {"startObserving", StartObserving}, {"stopObserving", StopObserving},
  };
  for (const auto &method : methods) {
    napi_value function = nullptr;
    napi_create_function(env, method.name, NAPI_AUTO_LENGTH, method.callback, nullptr, &function);
    napi_set_named_property(env, exports, method.name, function);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
