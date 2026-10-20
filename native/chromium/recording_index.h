#ifndef COMPONENTS_REMOTE_PAINT_RECORDING_INDEX_H_
#define COMPONENTS_REMOTE_PAINT_RECORDING_INDEX_H_
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>

namespace remote_paint {
inline constexpr size_t kRecordingIndexCharge=64*1024;
class RecordingKeyCache;
class RecordingIndexPool {
 public:
  struct Stats {size_t bytes,peak,limit,caches,denied;};
  explicit RecordingIndexPool(size_t limit);
  ~RecordingIndexPool();
  std::shared_ptr<RecordingKeyCache> CreateCache();
  Stats stats()const;
 private:
  struct State;
  std::shared_ptr<State> state_;
};
RecordingIndexPool& GetRecordingIndexPool();

// Scalar identities only: no RasterSource,display list,picture,image,font or
// encoded-payload reference can be retained by this cache.
class RecordingKeyCache {
 public:
  static constexpr size_t kCapacity=1024,kBuckets=2048;
  ~RecordingKeyCache();
  void BeginCapture();
  void EndCapture(bool success);
  std::optional<uint64_t> Reusable(int layer,int x,int y,uint64_t source,
      int width,int height,bool damage_known,bool damaged)const;
  void Put(int layer,int x,int y,uint64_t source,int width,int height,uint64_t key);
  size_t size()const{return size_;}
  static constexpr size_t BackingBytes();
 private:
  friend class RecordingIndexPool;
  struct Entry {
    uint64_t source=0,key=0,capture=0,use=0;
    int layer=0,x=0,y=0,width=0,height=0;
  };
  struct Storage {
    std::array<Entry,kCapacity> entries{};
    std::array<uint16_t,kBuckets> buckets{};
  };
  explicit RecordingKeyCache(std::shared_ptr<void> lease);
  size_t Bucket(int layer,int x,int y)const;
  std::optional<size_t> Find(int layer,int x,int y)const;
  void Insert(size_t index);
  void Rebuild();
  void Clear();
  // Reverse field destruction frees the fixed backing before returning credit.
  std::shared_ptr<void> lease_;
  std::unique_ptr<Storage> storage_;
  uint64_t capture_=0,use_=0;
  size_t size_=0;
};
constexpr size_t RecordingKeyCache::BackingBytes(){return sizeof(Storage);}
}
#endif
