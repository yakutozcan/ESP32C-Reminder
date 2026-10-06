#pragma once
#include <stdint.h>
#include <ctime>
#include <algorithm>
#include "cron_schedule.h"
namespace masa {
constexpr int64_t DAY_MS = 86400000;
struct Recurrence {
  enum Kind { Once, Daily, Weekly, Monthly, Interval, Cron } kind = Daily;
  CronRule cron;
  int minute = 0, monthDay = 1, intervalMinutes = 60, weekInterval = 1;
  unsigned weekdays = 127;
  int workStart = -1, workEnd = -1;
  int64_t scheduledAt = 0, anchorAt = 0;
  int anchorYear = 2026, anchorMonth = 1, anchorDay = 1;
};
inline tm local(int64_t millis) { time_t seconds = millis / 1000; tm value{}; localtime_r(&seconds, &value); return value; }
inline int64_t stamp(tm value, int minute) {
  value.tm_hour=minute/60;value.tm_min=minute%60;value.tm_sec=0;value.tm_isdst=-1;
  const tm requested=value;
  time_t chosen=mktime(&value);
  // Match JavaScript Date: choose the earlier instant in a repeated local hour;
  // move forward across a missing hour. libc's automatic DST choice can differ.
  bool exact=false;
  for(int daylight=0;daylight<=1;++daylight) {
    tm trial=requested;trial.tm_isdst=daylight;const time_t candidate=mktime(&trial);
    tm result{};localtime_r(&candidate,&result);
    const bool date=result.tm_year==requested.tm_year&&result.tm_mon==requested.tm_mon&&result.tm_mday==requested.tm_mday;
    const bool same=date&&result.tm_hour==requested.tm_hour&&result.tm_min==requested.tm_min;
    if(same){chosen=exact?std::min(chosen,candidate):candidate;exact=true;}
    else if(!exact&&date&&result.tm_hour*60+result.tm_min>minute)chosen=candidate;
  }
  return int64_t(chosen)*1000;
}
// Civil day number ignores DST: a calendar week always contains seven dates.
inline int64_t civilDay(int y, unsigned m, unsigned d) {
  y -= m <= 2; const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yy = unsigned(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  return era * 146097 + yy * 365 + yy / 4 - yy / 100 + doy;
}
inline int64_t mondayDay(tm value) { return civilDay(value.tm_year+1900, value.tm_mon+1, value.tm_mday) - (value.tm_wday+6)%7; }
inline bool allowed(const Recurrence& r, tm date) {
  if (!(r.weekdays & (1u << date.tm_wday))) return false;
  if (r.kind != Recurrence::Weekly || r.weekInterval == 1) return true;
  tm anchor{}; anchor.tm_year=r.anchorYear-1900; anchor.tm_mon=r.anchorMonth-1; anchor.tm_mday=r.anchorDay;
  anchor = local(stamp(anchor, 720));
  int64_t weeks = (mondayDay(date)-mondayDay(anchor))/7;
  return weeks % r.weekInterval == 0;
}
inline int64_t nextAfter(const Recurrence& r, int64_t after) {
  if (r.kind == Recurrence::Cron) return nextCron(r.cron,after);
  if (r.kind == Recurrence::Once) return r.scheduledAt > after ? r.scheduledAt : 0;
  if (r.kind == Recurrence::Interval && r.workStart < 0) {
    const int64_t step = int64_t(r.intervalMinutes)*60000;
    int64_t candidate = r.anchorAt > after ? r.anchorAt : r.anchorAt + ((after-r.anchorAt)/step+1)*step;
    const int64_t limit=after+732*DAY_MS;
    while(candidate<=limit) {
      tm date=local(candidate);if(allowed(r,date))return candidate;
      tm tomorrow=date;tomorrow.tm_mday++;const int64_t boundary=stamp(tomorrow,0);
      candidate=r.anchorAt+((boundary-r.anchorAt+step-1)/step)*step;
      if(candidate<boundary)candidate+=step;
    }
    return 0;
  }
  tm base = local(after);
  if (r.kind == Recurrence::Monthly) {
    for (int i=0; i<3; ++i) {
      tm end=base; end.tm_mon+=i+1; end.tm_mday=0; end=local(stamp(end,720));
      tm candidate=end; candidate.tm_mday=std::min(r.monthDay,end.tm_mday);
      const auto due=stamp(candidate,r.minute); if (due>after) return due;
    }
    return 0;
  }
  for (int i=0; i<22; ++i) {
    tm date=base; date.tm_mday+=i; date=local(stamp(date,720));
    if (!allowed(r,date)) continue;
    if (r.kind==Recurrence::Interval) {
      const int64_t start=stamp(date,r.workStart), end=stamp(date,r.workEnd),step=int64_t(r.intervalMinutes)*60000;
      const int64_t due=start>after?start:start+((after-start)/step+1)*step;
      if(due<end)return due;
    } else { const auto due=stamp(date,r.minute); if(due>after) return due; }
  }
  return 0;
}
inline int64_t latestDue(const Recurrence& r,int64_t first,int64_t now) {
  if (!first || first>now) return 0;
  if(r.kind==Recurrence::Cron) return latestCron(r.cron,first,now);
  if(r.kind==Recurrence::Once) return first>now-DAY_MS?first:0;
  int64_t due=nextAfter(r,std::max(first-1,now-DAY_MS)), latest=0;
  for(int i=0;due && due<=now && i<1441;++i) {latest=due;due=nextAfter(r,due);}
  return latest;
}
inline bool quietAt(int minute, bool enabled, int start, int end) { return enabled && (start<end ? minute>=start && minute<end : minute>=start || minute<end); }
struct IdleState {
  uint32_t awakeSince=0;
  uint32_t detailsSince=0;
  bool detailsRequested=false;
  void wake(uint32_t now) {awakeSince=now;detailsRequested=false;}
  void inspect(uint32_t now) {wake(now);detailsSince=now;detailsRequested=true;}
  bool showDetails(uint32_t now) {
    if(detailsRequested&&uint32_t(now-detailsSince)>=10000)detailsRequested=false;
    return detailsRequested;
  }
  unsigned contrast(uint32_t now) const {const auto elapsed=now-awakeSince;return elapsed>=120000?0:elapsed>=60000?40:180;}
};
}
