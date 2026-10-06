#pragma once
#include <stddef.h>
#include <stdint.h>
namespace masa {
// Both paths live in one LittleFS partition. Atomic rename is the only commit
// boundary; an interrupted temporary write never replaces the previous snapshot.
template<class Filesystem>
bool writeSnapshot(Filesystem& fs,const char* target,const char* temporary,const uint8_t* bytes,size_t size) {
  auto file=fs.open(temporary,"w");if(!file)return false;
  const size_t written=file.write(bytes,size);file.flush();const bool failed=file.getWriteError()!=0;file.close();
  if(written!=size||failed){fs.remove(temporary);return false;}
  return fs.rename(temporary,target);
}
}
