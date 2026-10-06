#include "display_policy.h"
#include <cassert>
#include <iostream>
using namespace masa;
int main() {
  DisplaySettings settings;const int64_t due=1791277200000LL;
  assert(!settings.alwaysOn&&settings.sleepMinutes==2&&settings.wakeBeforeMinutes==10&&settings.wakeAfterMinutes==10);
  assert(!displayAround(settings,due,due-600001));assert(displayAround(settings,due,due-600000));assert(displayAround(settings,due,due-1));
  assert(displayAround(settings,due,due));assert(displayAround(settings,due,due+599999));assert(!displayAround(settings,due,due+600000));assert(!displayAround(settings,0,due));
  settings.wakeBeforeMinutes=0;assert(!displayAround(settings,due,due-1));assert(displayAround(settings,due,due));
  settings.wakeAfterMinutes=0;assert(!displayAround(settings,due,due));settings.wakeBeforeMinutes=10;assert(displayAround(settings,due,due-1));assert(!displayAround(settings,due,due));
  settings=DisplaySettings{};
  assert(displayContrast(settings,59999,0,true,false)==180);assert(displayContrast(settings,60000,0,true,false)==40);assert(displayContrast(settings,119999,0,true,false)==40);assert(displayContrast(settings,120000,0,true,false)==0);
  assert(displayContrast(settings,999999,0,true,true)==180);assert(displayContrast(settings,999999,0,false,true)==0);assert(displayContrast(settings,999999,0,false,false,true)==180);
  settings.alwaysOn=true;assert(displayContrast(settings,999999,0,false,false)==180);settings.alwaysOn=false;
  settings.sleepMinutes=1;assert(displayContrast(settings,30000,0,true,false)==40);assert(displayContrast(settings,60000,0,true,false)==0);
  settings.sleepMinutes=1440;assert(displayContrast(settings,43200000,0,true,false)==40);assert(displayContrast(settings,86400000,0,true,false)==0);
  settings=DisplaySettings{};const uint32_t wake=UINT32_MAX-1000;assert(displayContrast(settings,1000,wake,true,false)==180);assert(displayContrast(settings,59000,wake,true,false)==40);assert(displayContrast(settings,119000,wake,true,false)==0);
  // Epoch windows never reset the manual wake clock; leaving one can immediately sleep.
  assert(displayContrast(settings,999999,0,true,true)==180);assert(displayContrast(settings,1000000,0,true,false)==0);
  DisplayState state;state.nextDue=due;changeDisplayHint(state,due+86400000,due+1);assert(state.previousDue==due);assert(displayAfter(state.settings,state.previousDue,due+500000));
  changeDisplayHint(state,0,due+1000);assert(state.previousDue==due);assert(state.nextDue==0); // Removed future hint adds no stale pre-window.
  state=DisplayState{};state.nextDue=due+900000;changeDisplayHint(state,0,due);assert(!state.previousDue);assert(!state.nextDue);
  state.nextDue=due;changeDisplayHint(state,due+300000,due+1);changeDisplayHint(state,due+86400000,due+300001);assert(state.previousDue==due+300000);
  assert(displayAfter(state.settings,state.previousDue,due+899999));assert(!displayAfter(state.settings,state.previousDue,due+900000));
  // Two different reminders keep their overlapping before/after windows continuous.
  assert(displayAfter(settings,due,due+599999)||displayBefore(settings,due+900000,due+599999));
  assert(!displayAfter(settings,due,due+600000)&&displayBefore(settings,due+900000,due+600000));
  std::cout<<"OLED settings, pre/post boundaries, hint removal, overlap, priority and rollover policy tests passed\n";
}
