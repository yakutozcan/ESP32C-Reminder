#pragma once
#include <stdint.h>
#include <stddef.h>
#include <cstring>
#include <ctime>
#include <algorithm>
#include <limits>
namespace masa {
struct CronRule {
  uint64_t masks[5]{}; // minute, hour, day of month, month, weekday
  bool domStar=false,dowStar=false;
};
inline bool cronNumber(const char*& cursor,const char* end,int64_t& value) {
  if(cursor==end||*cursor<'0'||*cursor>'9')return false;
  value=0;
  while(cursor<end&&*cursor>='0'&&*cursor<='9') {
    value=value*10+*cursor++-'0';if(value>2147483647LL)return false;
  }
  return true;
}
inline bool cronField(const char* begin,const char* end,int low,int high,uint64_t& mask,bool weekday=false) {
  mask=0;
  while(begin<end) {
    int64_t first=low,last=high,step=1;
    if(*begin=='*')++begin;
    else {
      if(!cronNumber(begin,end,first)||first<low||first>high)return false;
      last=first;
      if(begin<end&&*begin=='-') {++begin;if(!cronNumber(begin,end,last)||last<first||last>high)return false;}
      else if(begin<end&&*begin=='/')last=high;
    }
    if(begin<end&&*begin=='/') {++begin;if(!cronNumber(begin,end,step)||step<1)return false;}
    for(int64_t number=first;number<=last;) {
      mask|=uint64_t(1)<<(weekday&&number==7?0:number);
      if(last-number<step)break;number+=step;
    }
    if(begin==end)return mask!=0;
    if(*begin++!=','||begin==end)return false;
  }
  return false;
}
inline bool cronLeap(int year){return year%4==0&&(year%100!=0||year%400==0);}
inline int cronMonthDays(int year,int month){const int days[]={31,28,31,30,31,30,31,31,30,31,30,31};return days[month-1]+(month==2&&cronLeap(year));}
inline bool parseCron(const char* expression,CronRule& rule) {
  if(!expression||!std::strlen(expression)||std::strlen(expression)>256)return false;
  CronRule parsed;const int low[]={0,0,1,1,0},high[]={59,23,31,12,7};const char* cursor=expression;
  for(int field=0;field<5;++field) {
    while(*cursor==' '||*cursor=='\t')++cursor;
    const char* first=cursor;while(*cursor&&*cursor!=' '&&*cursor!='\t')++cursor;
    if(first==cursor||!cronField(first,cursor,low[field],high[field],parsed.masks[field],field==4))return false;
    if(field==2)parsed.domStar=*first=='*';if(field==4)parsed.dowStar=*first=='*';
  }
  while(*cursor==' '||*cursor=='\t')++cursor;if(*cursor)return false;
  // Under Vixie's OR rule a selected weekday always makes a month feasible.
  // Otherwise at least one selected calendar date must exist (leap years included).
  bool feasible=!parsed.domStar&&!parsed.dowStar;
  for(int month=1;!feasible&&month<=12;++month)if(parsed.masks[3]&(uint64_t(1)<<month))
    for(int day=1;day<=cronMonthDays(2000,month);++day)if(parsed.masks[2]&(uint64_t(1)<<day))feasible=true;
  if(!feasible)return false;rule=parsed;return true;
}
inline int64_t cronCivilDay(int year,unsigned month,unsigned day) {
  year-=month<=2;const int era=(year>=0?year:year-399)/400;const unsigned y=unsigned(year-era*400);
  const unsigned doy=(153*(month+(month>2?-3:9))+2)/5+day-1;
  return int64_t(era)*146097+y*365+y/4-y/100+doy;
}
inline bool cronDate(const CronRule& rule,const tm& date) {
  if(!(rule.masks[3]&(uint64_t(1)<<(date.tm_mon+1))))return false;
  bool dom=rule.masks[2]&(uint64_t(1)<<date.tm_mday),dow=rule.masks[4]&(uint64_t(1)<<date.tm_wday);
  return !rule.domStar&&!rule.dowStar?dom||dow:dom&&dow;
}
inline tm cronLocal(int64_t millis){time_t seconds=time_t(millis/1000);tm date{};localtime_r(&seconds,&date);return date;}
inline int64_t cronWall(const tm& date){return cronCivilDay(date.tm_year+1900,date.tm_mon+1,date.tm_mday)*86400000LL+(date.tm_hour*3600+date.tm_min*60+date.tm_sec)*1000LL;}
inline void cronAdvanceDate(tm& date,int direction) {
  date.tm_wday=(date.tm_wday+direction+7)%7;date.tm_mday+=direction;
  if(date.tm_mday>cronMonthDays(date.tm_year+1900,date.tm_mon+1)){date.tm_mday=1;if(++date.tm_mon==12){date.tm_mon=0;++date.tm_year;}}
  else if(date.tm_mday<1){if(--date.tm_mon<0){date.tm_mon=11;--date.tm_year;}date.tm_mday=cronMonthDays(date.tm_year+1900,date.tm_mon+1);}
}
inline int64_t cronOnDate(const CronRule& rule,tm date,int64_t low,int64_t high,bool latest) {
  if(!cronDate(rule,date))return 0;
  date.tm_hour=12;date.tm_min=0;date.tm_sec=0;date.tm_isdst=-1;
  const int64_t noon=int64_t(mktime(&date))*1000;
  int64_t offsets[3]{};size_t count=0;
  // A date can contain both seasonal offsets. Adjacent-day samples recover both
  // without asking libc to choose one side of an ambiguous local minute.
  for(int day=-1;day<=1;++day) {
    const int64_t sample=noon+day*86400000LL;
    if(sample/1000<std::numeric_limits<time_t>::min()||sample/1000>std::numeric_limits<time_t>::max())continue;
    const int64_t offset=cronWall(cronLocal(sample))-sample;bool seen=false;
    for(size_t i=0;i<count;++i)if(offsets[i]==offset)seen=true;
    if(!seen)offsets[count++]=offset;
  }
  const int64_t midnight=cronCivilDay(date.tm_year+1900,date.tm_mon+1,date.tm_mday)*86400000LL;
  int64_t best=0;
  for(int hour=0;hour<24;++hour)if(rule.masks[1]&(uint64_t(1)<<hour))
    for(int minute=0;minute<60;++minute)if(rule.masks[0]&(uint64_t(1)<<minute))
      for(size_t offset=0;offset<count;++offset) {
        const int64_t candidate=midnight+(hour*60+minute)*60000LL-offsets[offset];
        if(candidate<=low||candidate>high||(best&&(latest?candidate<=best:candidate>=best)))continue;
        if(candidate/1000<std::numeric_limits<time_t>::min()||candidate/1000>std::numeric_limits<time_t>::max())continue;
        const tm roundtrip=cronLocal(candidate);
        if(roundtrip.tm_year==date.tm_year&&roundtrip.tm_mon==date.tm_mon&&roundtrip.tm_mday==date.tm_mday&&roundtrip.tm_hour==hour&&roundtrip.tm_min==minute&&roundtrip.tm_sec==0)best=candidate;
      }
  return best;
}
inline int64_t nextCronBounded(const CronRule& rule,int64_t after,int64_t maximum) {
  if(after>=maximum)return 0;
  tm date=cronLocal(after),limit=date;limit.tm_year+=400;
  // Gregorian date/weekday combinations repeat every 400 years. Vixie's AND
  // rule can leave decades between valid occurrences; an eight-year cutoff
  // would incorrectly discard valid February/weekday expressions.
  int64_t lastDay=cronCivilDay(limit.tm_year+1900,limit.tm_mon+1,limit.tm_mday);
  if(maximum<std::numeric_limits<int64_t>::max()) {
    const tm representable=cronLocal(maximum);
    lastDay=std::min(lastDay,cronCivilDay(representable.tm_year+1900,representable.tm_mon+1,representable.tm_mday));
  }
  while(cronCivilDay(date.tm_year+1900,date.tm_mon+1,date.tm_mday)<=lastDay) {
    const int64_t candidate=cronOnDate(rule,date,after,maximum,false);
    if(candidate)return candidate;cronAdvanceDate(date,1);
  }
  return 0;
}
inline int64_t nextCron(const CronRule& rule,int64_t after) {
  // ESP32 Arduino 2 has signed 32-bit time_t. Stop on its last local date
  // instead of scanning centuries which that runtime cannot represent.
  const int64_t maximum=sizeof(time_t)<=4?int64_t(std::numeric_limits<time_t>::max())*1000:std::numeric_limits<int64_t>::max();
  return nextCronBounded(rule,after,maximum);
}
inline int64_t latestCron(const CronRule& rule,int64_t first,int64_t now) {
  if(!first||first>now)return 0;
  const int64_t lower=std::max(first-1,now-86400000LL);
  tm date=cronLocal(now);const tm earliest=cronLocal(lower+1);
  const int64_t firstDay=cronCivilDay(earliest.tm_year+1900,earliest.tm_mon+1,earliest.tm_mday);
  while(cronCivilDay(date.tm_year+1900,date.tm_mon+1,date.tm_mday)>=firstDay) {
    const int64_t due=cronOnDate(rule,date,lower,now,true);if(due)return due;cronAdvanceDate(date,-1);
  }
  return 0;
}
}
