#include "components/remote_paint/recording_index.h"
#include <algorithm>
#include <atomic>
#include <charconv>
#include <cstdlib>
#include <cstring>
#if defined(REMOTE_PAINT_CHROMIUM)
#include "base/compiler_specific.h"
#else
#define UNSAFE_BUFFERS(...) __VA_ARGS__
#endif

namespace remote_paint {
struct RecordingIndexPool::State {
 explicit State(size_t value):limit(value){}
 const size_t limit;
 std::atomic<size_t> used{0},peak{0},caches{0},denied{0};
};
RecordingIndexPool::RecordingIndexPool(size_t limit):state_(std::make_shared<State>(limit)){}
RecordingIndexPool::~RecordingIndexPool()=default;
std::shared_ptr<RecordingKeyCache> RecordingIndexPool::CreateCache(){
 static_assert(RecordingKeyCache::BackingBytes()+sizeof(RecordingKeyCache)+1024<=kRecordingIndexCharge);
 struct Lease {
  explicit Lease(std::shared_ptr<State> value):state(std::move(value)){}
  std::shared_ptr<State> state;
  ~Lease(){state->used.fetch_sub(kRecordingIndexCharge);state->caches.fetch_sub(1);}
 };
 auto used=state_->used.load();
 for(;;){
  if(kRecordingIndexCharge>state_->limit||used>state_->limit-kRecordingIndexCharge){state_->denied.fetch_add(1);return {};}
  if(state_->used.compare_exchange_weak(used,used+kRecordingIndexCharge))break;
 }
 auto peak=state_->peak.load();while(peak<used+kRecordingIndexCharge&&!state_->peak.compare_exchange_weak(peak,used+kRecordingIndexCharge)){}
 state_->caches.fetch_add(1);
 auto lease=std::make_shared<Lease>(state_);
 return std::shared_ptr<RecordingKeyCache>(new RecordingKeyCache(std::move(lease)));
}
RecordingIndexPool::Stats RecordingIndexPool::stats()const{return {state_->used.load(),state_->peak.load(),state_->limit,state_->caches.load(),state_->denied.load()};}
RecordingIndexPool& GetRecordingIndexPool(){
 static RecordingIndexPool* const pool=[]{
  size_t limit=8*1024*1024;
  if(const char* text=std::getenv("REMOTE_PAINT_RECORDING_INDEX_BYTES")){
   const auto result=UNSAFE_BUFFERS(std::from_chars(text,text+std::strlen(text),limit));
   if(result.ec!=std::errc()||*result.ptr!='\0'||limit<kRecordingIndexCharge||limit>256*1024*1024)limit=0;
  }
  return new RecordingIndexPool(limit);
 }();return *pool;
}
RecordingKeyCache::RecordingKeyCache(std::shared_ptr<void> lease)
 :lease_(std::move(lease)),storage_(std::make_unique<Storage>()){}
RecordingKeyCache::~RecordingKeyCache()=default;
size_t RecordingKeyCache::Bucket(int layer,int x,int y)const{
 uint64_t h=static_cast<uint32_t>(layer);
 h^=uint64_t(static_cast<uint32_t>(x))*0x9e3779b185ebca87ULL;
 h^=uint64_t(static_cast<uint32_t>(y))*0xc2b2ae3d27d4eb4fULL;
 h^=h>>33;h*=0xff51afd7ed558ccdULL;h^=h>>33;
 return h&(kBuckets-1);
}
std::optional<size_t> RecordingKeyCache::Find(int layer,int x,int y)const{
 auto bucket=Bucket(layer,x,y);
 for(size_t n=0;n<kBuckets;n++,bucket=(bucket+1)&(kBuckets-1)){
  const auto index=storage_->buckets[bucket];if(!index)return {};
  const auto& entry=storage_->entries[index-1];
  if(entry.layer==layer&&entry.x==x&&entry.y==y)return index-1;
 }
 return {};
}
void RecordingKeyCache::Insert(size_t index){
 const auto& entry=storage_->entries[index];auto bucket=Bucket(entry.layer,entry.x,entry.y);
 for(size_t n=0;n<kBuckets;n++,bucket=(bucket+1)&(kBuckets-1)){
  if(!storage_->buckets[bucket]){storage_->buckets[bucket]=static_cast<uint16_t>(index+1);return;}
 }
}
void RecordingKeyCache::Rebuild(){
 storage_->buckets.fill(0);
 for(size_t i=0;i<kCapacity;i++)if(storage_->entries[i].key)Insert(i);
}
void RecordingKeyCache::Clear(){
 for(auto& e:storage_->entries)e=Entry{};
 storage_->buckets.fill(0);size_=0;
}
void RecordingKeyCache::BeginCapture(){
 if(++capture_==0){Clear();capture_=1;}
}
void RecordingKeyCache::EndCapture(bool success){
 if(!success)return;
 bool removed=false;
 for(auto& entry:storage_->entries)if(entry.key&&entry.capture!=capture_){entry=Entry{};size_--;removed=true;}
 if(removed)Rebuild();
}
std::optional<uint64_t> RecordingKeyCache::Reusable(int layer,int x,int y,uint64_t source,int width,int height,bool damage_known,bool damaged)const{
 const auto index=Find(layer,x,y);if(!index)return {};
 const auto& entry=storage_->entries[*index];
 if(!source||entry.width!=width||entry.height!=height||damaged||(entry.source!=source&&!damage_known))return {};
 return entry.key;
}
void RecordingKeyCache::Put(int layer,int x,int y,uint64_t source,int width,int height,uint64_t key){
 if(!source||!key)return;
 if(++use_==0){Clear();use_=1;}
 auto index=Find(layer,x,y);bool rebuild=false;
 if(!index){
  for(size_t i=0;i<kCapacity;i++)if(!storage_->entries[i].key){index=i;size_++;break;}
  if(!index){
   index=static_cast<size_t>(std::min_element(storage_->entries.begin(),storage_->entries.end(),
       [](const Entry& a,const Entry& b){return a.use<b.use;})-storage_->entries.begin());rebuild=true;
  }
  storage_->entries[*index]={source,key,capture_,use_,layer,x,y,width,height};
  if(rebuild)Rebuild();else Insert(*index);
 }else storage_->entries[*index]={source,key,capture_,use_,layer,x,y,width,height};
}
}
