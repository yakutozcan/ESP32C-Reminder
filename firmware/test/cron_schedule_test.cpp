#include "autonomous_clock.h"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <string>
using namespace masa;
int64_t at(int y,int month,int day,int hour,int minute=0) {tm value{};value.tm_year=y-1900;value.tm_mon=month-1;value.tm_mday=day;return stamp(value,hour*60+minute);}
int64_t folded(int y,int month,int day,int hour,int minute,int daylight) {tm value{};value.tm_year=y-1900;value.tm_mon=month-1;value.tm_mday=day;value.tm_hour=hour;value.tm_min=minute;value.tm_isdst=daylight;return int64_t(mktime(&value))*1000;}
CronRule rule(const char* expression){CronRule value;assert(parseCron(expression,value));return value;}
int main() {
  setenv("TZ","UTC0",1);tzset();CronRule cron;
  for(const char* invalid:{"","* * * *","* * * * * *","60 * * * *","* 24 * * *","* * 0 * *","* * * 13 *","* * * * 8","*/0 * * * *","*/2147483648 * * * *","1--3 * * * *","1, * * * *","1,,2 * * * *","JAN * * * *","@hourly","* * 31 2 *","0 0 30 2 */1","1-0 * * * *","1/abc * * * *"})assert(!parseCron(invalid,cron));
  assert(!parseCron(std::string(257,' ').c_str(),cron));
  cron=rule("*/15 9-17/2 * 1,6 1-5");assert(cron.masks[0]==((1ULL<<0)|(1ULL<<15)|(1ULL<<30)|(1ULL<<45)));assert(cron.domStar&&!cron.dowStar);assert(cron.masks[1]&(1ULL<<17));
  assert(nextCron(cron,at(2026,1,5,9))==at(2026,1,5,9,15));
  assert(nextCron(cron,at(2026,1,5,9,15))==at(2026,1,5,9,30));
  cron=rule("5/15 * * * *");assert(nextCron(cron,at(2026,10,6,9,5))==at(2026,10,6,9,20));
  cron=rule("*/2147483647 * * * *");assert(nextCron(cron,at(2026,10,6,9))==at(2026,10,6,10));
  cron=rule("0 9 * * 7");assert(nextCron(cron,at(2026,10,6,9))==at(2026,10,11,9));
  assert(rule("0 9 * * 5-7").masks[4]==((1ULL<<5)|(1ULL<<6)|1ULL));
  // The leading '*' flag is semantic: full numeric DOM range still uses OR.
  cron=rule("0 9 1-31 * 1");assert(nextCron(cron,at(2026,10,6,8))==at(2026,10,6,9));
  cron=rule("0 9 * * 1");assert(nextCron(cron,at(2026,10,6,8))==at(2026,10,12,9));
  cron=rule("0 9 31 2 1");assert(nextCron(cron,at(2026,2,1,0))==at(2026,2,2,9)); // DOM impossible, DOW satisfies OR.
  cron=rule("0 9 */2 2 1");assert(nextCron(cron,at(2026,2,1,0))==at(2026,2,9,9)); // Leading-star DOM uses AND.
  cron=rule("0 9 29 2 *");assert(nextCron(cron,at(2026,2,1,0))==at(2028,2,29,9));
  assert(nextCron(cron,at(2096,2,29,9))==at(2104,2,29,9)); // Non-leap-century gap.
  cron=rule("0 0 */31 2 0"); // February 1 AND Sunday: an eleven-year gap exists.
  assert(nextCron(cron,at(2037,2,1,0))==at(2043,2,1,0));
  assert(nextCron(cron,at(2043,2,1,0))==at(2054,2,1,0));
  cron=rule("0 0 29 2 */7"); // February 29 AND Sunday: 28 and 40-year gaps.
  assert(nextCron(cron,at(2032,2,29,0))==at(2060,2,29,0));
  assert(nextCron(cron,at(2088,2,29,0))==at(2128,2,29,0));
  const int64_t signed32Maximum=2147483647000LL;
  assert(nextCronBounded(cron,at(2032,2,29,0),signed32Maximum)==0);
  cron=rule("* * * * *");
  assert(nextCronBounded(cron,signed32Maximum,signed32Maximum)==0);
  assert(nextCronBounded(cron,signed32Maximum-7000,signed32Maximum)==0);
  assert(nextCronBounded(cron,signed32Maximum-67000,signed32Maximum)==signed32Maximum-7000);
  cron=rule("59 23 31 12 *");assert(nextCron(cron,at(2026,12,31,23,59))==at(2027,12,31,23,59));
  cron=rule("* * * * *");const auto now=at(2026,10,6,9,15)+32123;
  assert(nextCron(cron,now)==at(2026,10,6,9,16));assert(latestCron(cron,at(2026,1,1,0),now)==at(2026,10,6,9,15));
  assert(latestCron(cron,at(2026,10,6,9,16),now)==0);
  cron=rule("0 9 * * *");assert(latestCron(cron,at(2026,10,5,9),at(2026,10,6,9)-1)==at(2026,10,5,9));
  cron=rule("0 9 * * 1");assert(latestCron(cron,at(2026,10,5,9),at(2026,10,6,9))==0); // Strict grace boundary.
  setenv("TZ","STD-5:45",1);tzset();cron=rule("17 9 * * *");assert(nextCron(cron,at(2026,10,6,9,16))==at(2026,10,6,9,17));
  setenv("TZ","STD5DST4,M3.2.0/2,M11.1.0/2",1);tzset();
  cron=rule("30 2 * * *");assert(nextCron(cron,at(2026,3,8,0))==at(2026,3,9,2,30)); // Missing minute is skipped.
  cron=rule("30 1 * * *");const auto first=folded(2026,11,1,1,30,1),second=folded(2026,11,1,1,30,0);
  assert(second-first==3600000);assert(nextCron(cron,at(2026,11,1,0))==first);assert(nextCron(cron,first)==second);assert(nextCron(cron,second)==at(2026,11,2,1,30));
  assert(latestCron(cron,first,second)==second);
  cron=rule("* 1 * * *");assert(nextCron(cron,folded(2026,11,1,1,59,1))==folded(2026,11,1,1,0,0));
  cron=rule("* * * * *");assert(nextCron(cron,folded(2026,3,8,1,59,0))==at(2026,3,8,3));
  setenv("TZ","STD-10:30DST-11,M10.1.0/2,M4.1.0/2",1);tzset();
  cron=rule("45 1 * * *");const auto halfFirst=folded(2026,4,5,1,45,1),halfSecond=folded(2026,4,5,1,45,0);
  assert(halfSecond-halfFirst==1800000);assert(nextCron(cron,halfFirst)==halfSecond);
  Recurrence recurrence;recurrence.kind=Recurrence::Cron;recurrence.cron=cron;assert(nextAfter(recurrence,halfFirst)==halfSecond);assert(latestDue(recurrence,halfFirst,halfSecond)==halfSecond);
  std::cout<<"Cron parser, Vixie day semantics, leap calendars, precise grace and DST gap/fold tests passed\n";
}
