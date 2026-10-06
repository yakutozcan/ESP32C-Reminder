#include "autonomous_clock.h"
#include "atomic_snapshot.h"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <map>
#include <string>
using namespace masa;
int64_t at(int y,int mon,int day,int h,int m=0) {tm date{};date.tm_year=y-1900;date.tm_mon=mon-1;date.tm_mday=day;return stamp(date,h*60+m);}
struct FakeFS {
  std::map<std::string,std::string> files;
  bool failOpen=false,failWrite=false,failFlush=false,failRename=false;
  struct File {
    FakeFS* fs;std::string name;bool valid;
    explicit operator bool()const{return valid;}
    size_t write(const uint8_t* text,size_t length){size_t n=fs->failWrite?length/2:length;fs->files[name].assign(reinterpret_cast<const char*>(text),n);return n;}
    void flush(){} int getWriteError(){return fs->failFlush?1:0;}void close(){}
  };
  File open(const char* name,const char*){return {this,name,!failOpen};}
  bool remove(const char* name){files.erase(name);return true;}
  bool rename(const char* from,const char* to){if(failRename)return false;files[to]=files[from];files.erase(from);return true;}
};
int main() {
  setenv("TZ","STD-3",1);tzset();
  Recurrence r;r.minute=9*60;
  assert(nextAfter(r,at(2026,10,6,8))==at(2026,10,6,9));
  assert(nextAfter(r,at(2026,10,6,9))==at(2026,10,7,9));
  assert(latestDue(r,at(2026,10,1,9),at(2026,10,6,12))==at(2026,10,6,9));
  assert(latestDue(r,at(2026,10,6,13),at(2026,10,6,12))==0);
  r.kind=Recurrence::Once;r.scheduledAt=at(2026,10,6,9);
  assert(nextAfter(r,r.scheduledAt)==0);assert(latestDue(r,r.scheduledAt,r.scheduledAt+DAY_MS)==0);assert(latestDue(r,r.scheduledAt,r.scheduledAt+DAY_MS-1)==r.scheduledAt);
  r.kind=Recurrence::Monthly;r.monthDay=31;
  assert(nextAfter(r,at(2026,2,1,0))==at(2026,2,28,9));
  assert(nextAfter(r,at(2024,2,1,0))==at(2024,2,29,9));
  assert(nextAfter(r,at(2026,12,31,9))==at(2027,1,31,9));
  r.kind=Recurrence::Weekly;r.weekInterval=2;r.weekdays=1u<<1;r.anchorYear=2026;r.anchorMonth=10;r.anchorDay=5;
  assert(nextAfter(r,at(2026,10,5,9))==at(2026,10,19,9));
  assert(nextAfter(r,at(2026,10,1,9))==at(2026,10,5,9));
  r.kind=Recurrence::Interval;r.intervalMinutes=120;r.weekdays=127;r.anchorAt=at(2026,10,5,9);
  assert(nextAfter(r,at(2026,10,5,10))==at(2026,10,5,11));
  assert(nextAfter(r,at(2026,10,5,9))==at(2026,10,5,11));
  r.workStart=9*60;r.workEnd=17*60;r.weekdays=62;
  assert(nextAfter(r,at(2026,10,9,16))==at(2026,10,12,9));
  assert(nextAfter(r,at(2026,10,6,11))==at(2026,10,6,13));
  // Window ignores global anchor and starts a fresh grid each working day.
  r.anchorAt=at(2026,12,1,0);assert(nextAfter(r,at(2026,10,6,8))==at(2026,10,6,9));
  r.workStart=-1;r.workEnd=-1;r.anchorAt=at(2026,10,5,9);r.intervalMinutes=10080;r.weekdays=1u<<2;
  assert(nextAfter(r,at(2026,10,5,9))==0); // Impossible weekly grid with Tuesday restriction.
  r.weekdays=1u<<1;assert(nextAfter(r,at(2026,10,5,9))==at(2026,10,12,9));
  assert(quietAt(23*60,true,22*60,8*60));assert(quietAt(7*60,true,22*60,8*60));assert(!quietAt(8*60,true,22*60,8*60));assert(!quietAt(23*60,false,22*60,8*60));
  assert(quietAt(9*60,true,9*60,17*60));assert(!quietAt(17*60,true,9*60,17*60));
  setenv("TZ","STD5DST4,M3.2.0/2,M11.1.0/2",1);tzset();
  r=Recurrence{};r.minute=9*60;
  assert(nextAfter(r,at(2026,3,7,9))-at(2026,3,7,9)==23*60*60*1000LL);
  assert(nextAfter(r,at(2026,10,31,9))-at(2026,10,31,9)==25*60*60*1000LL);
  r.minute=150;
  assert(nextAfter(r,at(2026,3,8,1))==at(2026,3,8,3,30));
  r.minute=90;
  tm firstRepeated{};firstRepeated.tm_year=126;firstRepeated.tm_mon=10;firstRepeated.tm_mday=1;firstRepeated.tm_hour=1;firstRepeated.tm_min=30;firstRepeated.tm_isdst=1;
  const int64_t firstRepeatedMillis=int64_t(mktime(&firstRepeated))*1000;
  assert(nextAfter(r,at(2026,11,1,0))==firstRepeatedMillis);
  assert(nextAfter(r,firstRepeatedMillis)==at(2026,11,2,1,30));
  r.kind=Recurrence::Interval;r.workStart=60;r.workEnd=4*60;r.intervalMinutes=60;r.weekdays=127;
  auto first=at(2026,3,8,1);assert(nextAfter(r,first)==at(2026,3,8,3));assert(nextAfter(r,at(2026,3,8,3))==at(2026,3,9,1));
  IdleState idle;idle.wake(100);assert(!idle.showDetails(100));assert(!idle.showDetails(5100));assert(!idle.showDetails(20100));assert(idle.contrast(60099)==180);assert(idle.contrast(60100)==40);assert(idle.contrast(120100)==0);idle.wake(120100);assert(idle.contrast(120101)==180);
  idle.inspect(200000);assert(idle.showDetails(200000));assert(idle.showDetails(209999));assert(!idle.showDetails(210000));assert(!idle.showDetails(220000));
  idle.inspect(300000);idle.wake(300001);assert(!idle.showDetails(300001)); // Real notifications cancel the manual glance.
  idle.inspect(UINT32_MAX-10);assert(idle.showDetails(10));assert(!idle.showDetails(10000));assert(!idle.showDetails(UINT32_MAX-10)); // Expired previews never revive after rollover.
  idle.wake(UINT32_MAX-10);assert(idle.contrast(10)==180); // Millis rollover remains awake.
  FakeFS fs;fs.files["state"]="old";fs.files["wifi"]="credentials";const uint8_t bytes[]={ 'n','e','w' };
  fs.failOpen=true;assert(!writeSnapshot(fs,"state","tmp",bytes,3));assert(fs.files["state"]=="old");fs.failOpen=false;
  fs.failWrite=true;assert(!writeSnapshot(fs,"state","tmp",bytes,3));assert(fs.files["state"]=="old");assert(!fs.files.count("tmp"));fs.failWrite=false;
  fs.failFlush=true;assert(!writeSnapshot(fs,"state","tmp",bytes,3));assert(fs.files["state"]=="old");fs.failFlush=false;
  fs.failRename=true;assert(!writeSnapshot(fs,"state","tmp",bytes,3));assert(fs.files["state"]=="old");assert(fs.files["tmp"]=="new");fs.failRename=false;
  assert(writeSnapshot(fs,"state","tmp",bytes,3));assert(fs.files["state"]=="new");assert(!fs.files.count("tmp"));assert(fs.files["wifi"]=="credentials");
  std::cout<<"Autonomous calendar, DST, idle and atomic persistence tests passed\n";
}
