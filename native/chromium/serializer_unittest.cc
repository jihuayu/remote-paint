#include "components/remote_paint/serializer.h"
#include "components/remote_paint/subscription_state.h"
#include "components/remote_paint/subscription_credit.h"
#include "components/remote_paint/socket_transport.h"
#include <future>
#include "components/remote_paint/canvas_capture.h"
#include "components/remote_paint/recording_index.h"
#include "components/remote_paint/viz_delivery.h"
#include "components/remote_paint/capture_frame_marker.h"
#include "components/remote_paint/asset_cache.h"
#include "components/remote_paint/capture_host_registry.h"
#include "components/remote_paint/encoded_picture.h"

#include <cstring>
#include <optional>
#include <array>
#include <chrono>
#include <latch>
#include <limits>
#include <semaphore>
#include <thread>
#include "third_party/skia/include/core/SkImage.h"
#include "third_party/skia/include/core/SkStream.h"
#include "third_party/skia/include/core/SkSerialProcs.h"
#include <string>

#include "base/compiler_specific.h"
#include "build/build_config.h"
#include "skia/ext/font_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkColorSpace.h"
#include "third_party/skia/include/core/SkFont.h"
#include "third_party/skia/include/core/SkFontMgr.h"
#include "third_party/skia/include/core/SkPictureRecorder.h"
#include "third_party/skia/include/core/SkSurface.h"
#include "third_party/skia/include/core/SkTextBlob.h"
#include "third_party/skia/include/core/SkTypeface.h"

namespace remote_paint {
namespace {
#if BUILDFLAG(IS_MAC)
constexpr char kTextFamily[] = "Arial";
constexpr char kColorFamily[] = "Apple Color Emoji";
#else
constexpr char kTextFamily[] = "DejaVu Sans";
constexpr char kColorFamily[] = "Noto Color Emoji";
#endif
sk_sp<SkPicture> TextPicture(const std::string& text, const char* family) {
  auto face = skia::DefaultFontMgr()->matchFamilyStyle(family, SkFontStyle());
  EXPECT_TRUE(face);
  SkFont font(face, 24);
  auto blob = SkTextBlob::MakeFromText(text.data(), text.size(), font);
  EXPECT_TRUE(blob);
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(640, 80);
  canvas->clear(SK_ColorWHITE);
  canvas->drawTextBlob(blob, 4, 36, SkPaint());
  return recorder.finishRecordingAsPicture();
}

TEST(RemotePaintSerializer, RetainsOriginalGlyphIdsAndPixels) {
  const auto original = TextPicture("Remote Paint glyph IDs 1579", kTextFamily);
  const auto encoded = SerializePicture(*original);
  ASSERT_TRUE(encoded.error.empty()) << encoded.error;
  ASSERT_TRUE(encoded.bytes);
  ASSERT_EQ(encoded.fonts.size(), 1u);
  EXPECT_LT(encoded.fonts[0].subset_bytes, encoded.fonts[0].original_bytes);
  auto decoded = SkPicture::MakeFromData(encoded.bytes->data(), encoded.bytes->size());
  ASSERT_TRUE(decoded);
  auto a = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640, 80));
  auto b = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640, 80));
  a->getCanvas()->drawPicture(original);
  b->getCanvas()->drawPicture(decoded);
  SkPixmap pa, pb;
  ASSERT_TRUE(a->peekPixels(&pa));
  ASSERT_TRUE(b->peekPixels(&pb));
  ASSERT_EQ(pa.computeByteSize(), pb.computeByteSize());
  // Both live raster surfaces expose exactly the validated pixmap byte size.
  EXPECT_EQ(UNSAFE_BUFFERS(std::memcmp(pa.addr(), pb.addr(), pa.computeByteSize())), 0);
}

TEST(RemotePaintSerializer, BitmapEmojiKeepsOriginalNativePixels) {
  const auto original = TextPicture("🌈", kColorFamily);
  const auto encoded = SerializePicture(*original);
  ASSERT_TRUE(encoded.error.empty()) << encoded.error;
  ASSERT_TRUE(encoded.bytes);
  ASSERT_GT(encoded.bitmap_glyphs,0u);
  ASSERT_GT(encoded.image_count,0u);
  SkDeserialProcs procs;
  procs.fImageProc=[](const void* data,size_t size,std::optional<SkAlphaType> alpha,void*) {
    return SkImages::DeferredFromEncodedData(SkData::MakeWithCopy(data,size),alpha);
  };
  auto decoded = SkPicture::MakeFromData(encoded.bytes->data(),encoded.bytes->size(),&procs);
  ASSERT_TRUE(decoded);
  auto a=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80,SkColorSpace::MakeSRGB()));
  auto b=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(640,80,SkColorSpace::MakeSRGB()));
  a->getCanvas()->drawPicture(original);b->getCanvas()->drawPicture(decoded);
  SkPixmap pa,pb;ASSERT_TRUE(a->peekPixels(&pa));ASSERT_TRUE(b->peekPixels(&pb));
  EXPECT_EQ(UNSAFE_BUFFERS(std::memcmp(pa.addr(),pb.addr(),pa.computeByteSize())),0);
}

TEST(RemotePaintSerializer, RefusesSmallBudgetInsteadOfDroppingFont) {
  const auto original = TextPicture("This font must be included", kTextFamily);
  const auto encoded = SerializePicture(*original, 100);
  EXPECT_FALSE(encoded.bytes);
  EXPECT_FALSE(encoded.error.empty());
}

TEST(RemotePaintSerializer, ReusesFontSubsetWhenOnlySurroundingRecordingChanges) {
  const auto picture=TextPicture("A stable font subset",kTextFamily);
  const auto first=SerializePicture(*picture);
  ASSERT_TRUE(first.bytes);
  SkPictureRecorder recorder;
  auto* canvas=recorder.beginRecording(640,80);
  canvas->translate(1,0);canvas->drawPicture(picture);
  const auto moved=recorder.finishRecordingAsPicture();
  const auto second=SerializePicture(*moved);
  ASSERT_TRUE(second.bytes);
  EXPECT_GT(second.font_cache_hits,0u);
}

TEST(RemotePaintSerializer, IsolationAnalysisPreservesDestructiveBlendSemantics) {
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(100, 100);
  SkPaint paint;
  paint.setColor(SK_ColorRED);
  canvas->drawRect(SkRect::MakeWH(20, 20), paint);
  auto safe = recorder.finishRecordingAsPicture();
  auto direct = SerializePicture(*safe);
  ASSERT_TRUE(direct.bytes);
  EXPECT_FALSE(direct.requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  canvas->clear(SK_ColorTRANSPARENT);
  canvas->drawPicture(safe);
  auto clear = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*clear).requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  paint.setBlendMode(SkBlendMode::kSrc);
  canvas->drawOval(SkRect::MakeWH(20, 20), paint);
  auto source = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*source).requires_isolation);
  canvas = recorder.beginRecording(100, 100);
  // SkPicture may elide a redundant null-paint layer. A Src layer restore
  // affects its destination and must retain isolation after normalization.
  canvas->saveLayer(nullptr, &paint);
  canvas->drawPicture(safe);
  canvas->restore();
  auto layer = recorder.finishRecordingAsPicture();
  EXPECT_TRUE(SerializePicture(*layer).requires_isolation);
}

TEST(RemotePaintSerializer, NestedPicturesKeepTheirFontCoverage) {
  auto child = TextPicture("Nested child text", kTextFamily);
  SkPictureRecorder recorder;
  auto* canvas = recorder.beginRecording(640, 160);
  canvas->drawPicture(child);
  canvas->translate(0, 80);
  canvas->drawPicture(child);
  auto parent = recorder.finishRecordingAsPicture();
  const auto encoded = SerializePicture(*parent);
  EXPECT_TRUE(encoded.error.empty()) << encoded.error;
  EXPECT_TRUE(encoded.bytes);
  EXPECT_EQ(encoded.fonts.size(), 1u);
}
}  // namespace
}  // namespace remote_paint

namespace remote_paint {
namespace {
TEST(RemotePaintSerializer, CompleteIndexRefusesOverflowInsteadOfTruncating) {
  for(int count:{256,257}) {
    SkPictureRecorder recorder;auto* canvas=recorder.beginRecording(64,64);
    for(int n=0;n<count;n++) {
      auto surface=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(1,1));ASSERT_TRUE(surface);
      surface->getCanvas()->clear(SkColorSetARGB(255,n&255,(n>>8)&255,100));
      canvas->drawImage(surface->makeImageSnapshot(),(n%20)*2,(n/20)*2);
    }
    const auto encoded=SerializePicture(*recorder.finishRecordingAsPicture());
    if(count==256){ASSERT_TRUE(encoded.bytes)<<encoded.error;EXPECT_TRUE(encoded.asset_ranges_complete);EXPECT_EQ(encoded.asset_ranges.size(),256u);}
    else {EXPECT_FALSE(encoded.bytes);EXPECT_FALSE(encoded.asset_ranges_complete);EXPECT_EQ(encoded.error,"Complete asset index exceeds range budget");}
  }
}
TEST(RemotePaintSerializer, CachedFontIndexKeepsRetainedGlyphSlotBound) {
  auto picture=TextPicture("A stable font subset with retained glyph IDs",kTextFamily);
  for(int n=0;n<2;n++) {
    auto encoded=SerializePicture(*picture);ASSERT_TRUE(encoded.bytes)<<encoded.error;ASSERT_TRUE(encoded.asset_ranges_complete);
    bool font=false;for(const auto& range:encoded.asset_ranges)if(range.kind=="font"){
      font=true;EXPECT_GT(range.glyph_slots,0u);EXPECT_LE(range.glyph_slots,65536u);
      SkMemoryStream stream(UNSAFE_BUFFERS(encoded.bytes->bytes()+range.offset),range.bytes,false);
      auto face=SkTypeface::MakeDeserialize(&stream,skia::DefaultFontMgr());ASSERT_TRUE(face);EXPECT_EQ(static_cast<size_t>(face->countGlyphs()),range.glyph_slots);
    }
    EXPECT_TRUE(font);if(n)EXPECT_GT(encoded.font_cache_hits,0u);
  }
}
}  // namespace
}  // namespace remote_paint

namespace remote_paint {
TEST(RemotePaintVizDelivery, FailedOrUnwrittenIdsNeverBecomeDelivered) {
  VizDeliveryQueue queue;
  ASSERT_TRUE(queue.Reserve("a"));
  EXPECT_FALSE(queue.Reserve("a"));
  queue.Submit("a", "scene");
  ASSERT_TRUE(queue.Take());
  queue.Complete(false);
  auto fault = queue.Take();
  ASSERT_TRUE(fault);
  EXPECT_EQ(fault->fault, VizDeliveryQueue::Fault::kTransport);
  EXPECT_EQ(fault->bytes, std::string("RVE2\x01\x01\x02", 7));
  EXPECT_FALSE(queue.Reserve("a"));
  queue.Complete(true);
  // This retry arrived during the fault write, potentially after the receiver
  // consumed its expectation list. It needs a second receipt before reopening.
  ASSERT_TRUE(queue.Take());
  queue.Complete(true);
  EXPECT_EQ(queue.history_size(), 0u);
  ASSERT_TRUE(queue.Reserve("a"));
  queue.Submit("a", "retry");
  ASSERT_TRUE(queue.Take());
  queue.Complete(true);
  EXPECT_FALSE(queue.Reserve("a"));
  EXPECT_EQ(queue.history_size(), 1u);
}
TEST(RemotePaintVizDelivery, SaturationEmitsOneFaultAndRetainsNoLostIds) {
  VizDeliveryQueue queue;
  ASSERT_TRUE(queue.Reserve("active"));
  queue.Submit("active", std::string(256 * 1024, 'a'));
  ASSERT_TRUE(queue.Take());
  ASSERT_TRUE(queue.Reserve("queued"));
  queue.Submit("queued", std::string(256 * 1024, 'b'));
  EXPECT_EQ(queue.buffered_bytes(), 512u * 1024);
  EXPECT_FALSE(queue.Reserve("rejected"));
  for (int n = 0; n < 10000; n++) EXPECT_FALSE(queue.Reserve(std::to_string(n)));
  EXPECT_EQ(queue.buffered_bytes(), 256u * 1024 + 7);
  queue.Complete(true);
  auto fault = queue.Take();
  ASSERT_TRUE(fault);
  EXPECT_EQ(fault->fault, VizDeliveryQueue::Fault::kOverloaded);
  EXPECT_EQ(fault->bytes, std::string("RVE2\x01\x01\x01", 7));
  queue.Complete(true);
  EXPECT_FALSE(queue.Take());
  EXPECT_EQ(queue.buffered_bytes(), 0u);
  EXPECT_EQ(queue.history_size(), 1u);
  EXPECT_TRUE(queue.Reserve("queued"));
  EXPECT_TRUE(queue.Reserve("rejected"));
}
TEST(RemotePaintVizDelivery, QueuedButNotStartedPacketsAreCoveredByTheFault) {
  VizDeliveryQueue queue;
  for (const auto* id : {"a", "b"}) {
    ASSERT_TRUE(queue.Reserve(id));
    queue.Submit(id, std::string(100000, 'x'));
  }
  EXPECT_FALSE(queue.Reserve("c"));
  EXPECT_EQ(queue.buffered_bytes(), 7u);
  auto fault = queue.Take();
  ASSERT_TRUE(fault);
  EXPECT_EQ(fault->fault, VizDeliveryQueue::Fault::kOverloaded);
  queue.Complete(true);
  EXPECT_EQ(queue.history_size(), 0u);
  EXPECT_TRUE(queue.Reserve("a"));
  EXPECT_TRUE(queue.Reserve("b"));
}
TEST(RemotePaintVizDelivery, TransportFailureAlsoCancelsConcurrentSerialization) {
  VizDeliveryQueue queue;
  ASSERT_TRUE(queue.Reserve("active"));
  queue.Submit("active", "scene");
  ASSERT_TRUE(queue.Take());
  ASSERT_TRUE(queue.Reserve("serializing"));
  queue.Complete(false);
  queue.Submit("serializing", "late scene");
  auto fault = queue.Take();
  ASSERT_TRUE(fault);
  EXPECT_EQ(fault->fault, VizDeliveryQueue::Fault::kTransport);
  queue.Complete(false);
  EXPECT_FALSE(queue.Take());
  EXPECT_EQ(queue.pending(), 0u);
  EXPECT_EQ(queue.buffered_bytes(), 0u);
  EXPECT_TRUE(queue.Reserve("serializing"));
}
TEST(RemotePaintVizDelivery, HistoryEvictsOneColdIdAndTouchesActiveSurfaces) {
  VizDeliveryQueue queue(2, 3);
  auto deliver = [&](const std::string& id) {
    ASSERT_TRUE(queue.Reserve(id));
    queue.Submit(id, "scene");
    ASSERT_TRUE(queue.Take());
    queue.Complete(true);
  };
  deliver("a");deliver("b");deliver("c");
  EXPECT_FALSE(queue.Reserve("a"));
  deliver("d");
  EXPECT_EQ(queue.history_size(), 3u);
  EXPECT_FALSE(queue.Reserve("a"));
  EXPECT_FALSE(queue.Reserve("c"));
  EXPECT_FALSE(queue.Reserve("d"));
  EXPECT_TRUE(queue.Reserve("b"));
}
}  // namespace remote_paint

namespace remote_paint {
TEST(RemotePaintCaptureMarker, ExactRequestedFrameCannotMatchASubsequentScene) {
  const auto marker = ParseCaptureFrameMarker(MakeCaptureFrameMarker("capture", 1));
  ASSERT_TRUE(marker);
  EXPECT_EQ(marker->id, "capture");
  EXPECT_TRUE(marker->versioned);
  EXPECT_TRUE(marker->Matches(1));
  EXPECT_FALSE(marker->Matches(2));
  EXPECT_FALSE(marker->Matches(0));
  EXPECT_TRUE(marker->Matches(1));
}
TEST(RemotePaintCaptureMarker, VersionAndBoundsAreValidatedWithoutLegacyDowngrade) {
  for (const auto* tag : {"rp1/", "rp1/0/a", "rp1/-1/a", "rp1/4294967296/a", "rp1/1/", "rp1/1x/a"})
    EXPECT_FALSE(ParseCaptureFrameMarker(tag));
  EXPECT_TRUE(MakeCaptureFrameMarker("", 1).empty());
  EXPECT_TRUE(MakeCaptureFrameMarker("a", 0).empty());
  EXPECT_TRUE(MakeCaptureFrameMarker(std::string(129, 'a'), 1).empty());
  const auto encoded = MakeCaptureFrameMarker(std::string(128, 'a'), 0xffffffffu);
  EXPECT_LE(encoded.size(), 256u);
  auto marker = ParseCaptureFrameMarker(encoded);
  ASSERT_TRUE(marker);
  EXPECT_EQ(marker->id.size(), 128u);
  EXPECT_TRUE(marker->Matches(0xffffffffu));
}
TEST(RemotePaintCaptureMarker, LegacyRawIdsRemainExplicitlyUnversioned) {
  auto marker = ParseCaptureFrameMarker("legacy-capture");
  ASSERT_TRUE(marker);
  EXPECT_EQ(marker->id, "legacy-capture");
  EXPECT_FALSE(marker->versioned);
  EXPECT_TRUE(marker->Matches(5));
  EXPECT_FALSE(ParseCaptureFrameMarker(std::string(129, 'a')));
}
TEST(RemotePaintCaptureMarker, NavigationHostsAreBoundedAndRequireFreshCaptureAfterEviction) {
  CaptureFrameMarkers markers;
  for (int host = 1; host <= 4; host++)
    EXPECT_FALSE(markers.Remember(host, std::to_string(host), 1).empty());
  EXPECT_EQ(markers.size(), 4u);
  const auto before = markers.Last(4);
  EXPECT_EQ(markers.Last(4), before);
  EXPECT_TRUE(ParseCaptureFrameMarker(markers.Last(4))->Matches(1));
  EXPECT_FALSE(ParseCaptureFrameMarker(markers.Last(4))->Matches(2));
  markers.Remember(1, "refresh", 3);
  markers.Remember(5, "new-host", 1);
  EXPECT_EQ(markers.size(), 4u);
  EXPECT_TRUE(markers.Last(2).empty());
  EXPECT_EQ(ParseCaptureFrameMarker(markers.Last(1))->id, "refresh");
  for (int host = 6; host < 1000; host++) markers.Remember(host, "bounded", 1);
  EXPECT_EQ(markers.size(), 4u);
  EXPECT_TRUE(markers.Last(1).empty());
}

namespace {
const auto kNoAssetMatch = [](const auto&, const auto&) { return false; };
const auto kIntCharge = [](const int&) -> std::optional<size_t> { return 1; };
}

TEST(RemotePaintAssets, BytePressureEvictsOnlyColdEntriesAndKeepsPinnedOwners) {
  AssetLru<int, int> cache(12, 4);
  auto cold = std::make_shared<const int>(2); std::weak_ptr<const int> weak = cold;
  EXPECT_TRUE(cache.Insert(1, std::make_shared<const int>(1), 4));
  EXPECT_TRUE(cache.Insert(2, cold, 4));
  EXPECT_TRUE(cache.Insert(3, std::make_shared<const int>(3), 4));
  EXPECT_EQ(*cache.Find(1, kNoAssetMatch), 1);
  EXPECT_TRUE(cache.Insert(4, std::make_shared<const int>(4), 4));
  EXPECT_FALSE(cache.Find(2, kNoAssetMatch));
  EXPECT_FALSE(weak.expired());
  EXPECT_TRUE(cache.Find(1, kNoAssetMatch));
  EXPECT_EQ(cache.size(), 3u); EXPECT_EQ(cache.bytes(), 12u);
  EXPECT_EQ(cache.evictions(), 1u);
  EXPECT_FALSE(cache.Insert(5, std::make_shared<const int>(5),
                            std::numeric_limits<size_t>::max()));
  EXPECT_EQ(cache.size(), 3u); EXPECT_TRUE(cache.Find(1, kNoAssetMatch));
  cold.reset(); EXPECT_TRUE(weak.expired());
}

TEST(RemotePaintAssets, AdequateFontSupersetTouchesTheActualLruEntry) {
  using Key = std::set<int>;
  AssetLru<Key, int> fonts(2, 10);
  fonts.Insert({1, 2}, std::make_shared<const int>(12), 1);
  fonts.Insert({3}, std::make_shared<const int>(3), 1);
  const auto subset = fonts.Find({1}, [](const Key& key, const int&) {
    return key.contains(1);
  });
  ASSERT_TRUE(subset); EXPECT_EQ(*subset, 12);
  fonts.Insert({4}, std::make_shared<const int>(4), 1);
  EXPECT_FALSE(fonts.Find({3}, kNoAssetMatch));
  EXPECT_TRUE(fonts.Find({1, 2}, kNoAssetMatch));
  EXPECT_EQ(fonts.bytes(), 2u);
}

TEST(RemotePaintAssets, ConcurrentFailureIsSharedOutsideTheCacheLockAndCanRetry) {
  AssetMemo<int, int> memo(8, 8);
  std::binary_semaphore started(0), resume(0);
  AssetMemo<int, int>::Result owner, waiter;
  std::thread first([&] {
    owner = memo.Get(1, kNoAssetMatch, [&]() -> std::shared_ptr<const int> {
      started.release(); resume.acquire(); return {};
    }, kIntCharge);
  });
  EXPECT_TRUE(started.try_acquire_for(std::chrono::seconds(2)));
  std::thread second([&] {
    waiter = memo.Get(1, kNoAssetMatch,
        [] { ADD_FAILURE() << "Same-key encoding was duplicated";
             return std::make_shared<const int>(99); }, kIntCharge);
  });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!memo.stats().shares && std::chrono::steady_clock::now() < deadline)
    std::this_thread::yield();
  EXPECT_EQ(memo.stats().shares, 1u);
  // This completes while the first encoder is blocked. Neither encoding nor
  // waiting owns the cache mutex, and clearing cannot discard an active job.
  const auto independent = memo.Get(2, kNoAssetMatch,
      [] { return std::make_shared<const int>(2); }, kIntCharge);
  EXPECT_EQ(*independent.value, 2); EXPECT_FALSE(memo.ClearForTesting());
  resume.release(); first.join(); second.join();
  EXPECT_FALSE(owner.value); EXPECT_FALSE(waiter.value);
  EXPECT_TRUE(waiter.shared_encoding); EXPECT_EQ(memo.stats().pending, 0u);
  const auto retry = memo.Get(1, kNoAssetMatch,
      [] { return std::make_shared<const int>(1); }, kIntCharge);
  ASSERT_TRUE(retry.value); EXPECT_EQ(*retry.value, 1);
  EXPECT_FALSE(retry.cache_hit); EXPECT_TRUE(memo.ClearForTesting());
}

TEST(RemotePaintAssets, PendingBookkeepingStaysBoundedWithoutDroppingOtherKeys) {
  AssetMemo<int, int> memo(8, 8, 1);
  std::binary_semaphore started(0), resume(0);
  std::thread first([&] {
    memo.Get(0, kNoAssetMatch, [&] {
      started.release(); resume.acquire(); return std::make_shared<const int>(0);
    }, kIntCharge);
  });
  EXPECT_TRUE(started.try_acquire_for(std::chrono::seconds(2)));
  for (int key = 1; key <= 1000; key++) {
    const auto result = memo.Get(key, kNoAssetMatch,
        [key] { return std::make_shared<const int>(key); }, kIntCharge);
    EXPECT_EQ(*result.value, key); EXPECT_EQ(memo.stats().pending, 1u);
    EXPECT_LE(memo.stats().bytes, 8u); EXPECT_LE(memo.stats().entries, 8u);
  }
  EXPECT_EQ(memo.stats().bypasses, 1000u);
  resume.release(); first.join(); EXPECT_EQ(memo.stats().pending, 0u);
}

TEST(RemotePaintSerializer, ImageCachePressureDoesNotFlushStableFontSubsets) {
  ASSERT_TRUE(ClearSerializerAssetCachesForTesting());
  const auto text = TextPicture("Stable font survives image pressure", kTextFamily);
  ASSERT_TRUE(SerializePicture(*text).bytes);
  sk_sp<SkPicture> first_image, last_image;
  for (int n = 0; n < 260; n++) {
    auto surface = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(4, 4));
    ASSERT_TRUE(surface); surface->getCanvas()->clear(SkColorSetARGB(255, n & 255, 30, 60));
    SkPictureRecorder recorder; auto* canvas = recorder.beginRecording(4, 4);
    canvas->drawImage(surface->makeImageSnapshot(), 0, 0);
    auto picture = recorder.finishRecordingAsPicture();
    ASSERT_TRUE(SerializePicture(*picture).bytes);
    if (!n) first_image = picture;
    if (n == 259) last_image = picture;
  }
  const auto stable = SerializePicture(*text);
  ASSERT_TRUE(stable.bytes) << stable.error; EXPECT_EQ(stable.font_cache_hits, 1u);
  EXPECT_EQ(SerializePicture(*last_image).image_cache_hits, 1u);
  const auto pressure = GetSerializerAssetCacheStats();
  EXPECT_EQ(pressure.font_encodes, 1u); EXPECT_EQ(pressure.font_entries, 1u);
  EXPECT_EQ(pressure.image_entries, 128u); EXPECT_EQ(pressure.image_evictions, 132u);
  EXPECT_LE(pressure.image_bytes, 32u * 1024 * 1024);
  EXPECT_LE(pressure.font_bytes, 32u * 1024 * 1024);
  EXPECT_EQ(SerializePicture(*first_image).image_cache_hits, 0u);
  EXPECT_TRUE(ClearSerializerAssetCachesForTesting());
}

TEST(RemotePaintCaptureHosts, ClosedIdentitiesCannotRetainOrResurrectPayloads) {
  CaptureHostRegistry<int> hosts;
  auto owner = hosts.Acquire(7);
  auto value = std::make_shared<const int>(42); std::weak_ptr<const int> weak = value;
  auto admitted=hosts.Store(owner, 1, std::move(value), sizeof(int));
  ASSERT_TRUE(admitted.cached); admitted.value.reset();
  auto in_flight = hosts.Lookup(owner, 1); ASSERT_TRUE(in_flight);
  auto retired = hosts.Release(7);
  EXPECT_EQ(hosts.stats().hosts, 0u); EXPECT_EQ(hosts.stats().encodings, 0u);
  EXPECT_FALSE(hosts.Lookup(owner, 1));
  EXPECT_FALSE(hosts.Store(owner, 2, std::make_shared<const int>(2), sizeof(int)).cached);
  retired.clear(); EXPECT_FALSE(weak.expired());
  in_flight.reset(); EXPECT_TRUE(weak.expired());
  EXPECT_EQ(hosts.stats().owners_alive, 1u);
  owner.reset(); EXPECT_EQ(hosts.stats().owners_alive, 0u);
}

TEST(RemotePaintCaptureHosts, LateEncoderCannotPublishIntoAReusedHostId) {
  CaptureHostRegistry<int> hosts;
  auto old_owner = hosts.Acquire(8);
  std::binary_semaphore started(0), resume(0); bool stored = true;
  std::thread worker([&, owner = old_owner] {
    started.release(); resume.acquire();
    stored = hosts.Store(owner, 1, std::make_shared<const int>(1), sizeof(int)).cached;
  });
  EXPECT_TRUE(started.try_acquire_for(std::chrono::seconds(5)));
  hosts.Release(8);
  auto current = hosts.Acquire(8);
  EXPECT_NE(current.get(), old_owner.get()); EXPECT_NE(current->serial, old_owner->serial);
  EXPECT_TRUE(hosts.Store(current, 1, std::make_shared<const int>(2), sizeof(int)).cached);
  resume.release(); worker.join(); EXPECT_FALSE(stored);
  ASSERT_TRUE(hosts.Lookup(current, 1)); EXPECT_EQ(*hosts.Lookup(current, 1), 2);
  EXPECT_EQ(hosts.stats().hosts, 1u); EXPECT_EQ(hosts.stats().encodings, 1u);
  EXPECT_EQ(hosts.stats().created, 2u); EXPECT_EQ(hosts.stats().released, 1u);
}

TEST(RemotePaintCaptureHosts, ManyRetiredSnapshotTokensKeepNoHostCacheEntries) {
  CaptureHostRegistry<int> hosts;
  std::vector<CaptureHostRegistry<int>::Owner> snapshots;
  for (int id = 1; id <= 1000; id++) {
    auto owner = hosts.Acquire(id);
    EXPECT_TRUE(hosts.Store(owner, 1, std::make_shared<const int>(id), sizeof(int)).cached);
    snapshots.push_back(owner); hosts.Release(id);
    EXPECT_EQ(hosts.stats().hosts, 0u); EXPECT_EQ(hosts.stats().encodings, 0u);
  }
  EXPECT_EQ(hosts.stats().created, 1000u); EXPECT_EQ(hosts.stats().released, 1000u);
  EXPECT_EQ(hosts.stats().owners_alive, 1000u);
  snapshots.clear(); EXPECT_EQ(hosts.stats().owners_alive, 0u);
}

TEST(RemotePaintCaptureHosts, ActiveHostsHaveIndependentRecordingNamespaces) {
  CaptureHostRegistry<int> hosts(2);
  auto first = hosts.Acquire(1), second = hosts.Acquire(2);
  EXPECT_EQ(hosts.Acquire(1).get(), first.get());
  EXPECT_TRUE(hosts.Store(first, 1, std::make_shared<const int>(11), sizeof(int)).cached);
  EXPECT_TRUE(hosts.Store(second, 1, std::make_shared<const int>(21), sizeof(int)).cached);
  EXPECT_TRUE(hosts.Store(first, 2, std::make_shared<const int>(12), sizeof(int)).cached);
  EXPECT_TRUE(hosts.Store(first, 3, std::make_shared<const int>(13), sizeof(int)).cached);
  EXPECT_FALSE(hosts.Lookup(first, 1)); EXPECT_EQ(*hosts.Lookup(second, 1), 21);
  hosts.Release(1); EXPECT_EQ(hosts.stats().encodings, 1u);
  EXPECT_EQ(*hosts.Lookup(second, 1), 21);
}

TEST(RemotePaintCaptureHosts, ByteLruIsGlobalAcrossHostsAndTouchesHotEntries) {
  CaptureHostRegistry<int> hosts(20,12,20,0);
  auto first=hosts.Acquire(1),second=hosts.Acquire(2);
  EXPECT_TRUE(hosts.Store(first,1,std::make_shared<const int>(11),4).cached);
  EXPECT_TRUE(hosts.Store(second,1,std::make_shared<const int>(21),4).cached);
  EXPECT_TRUE(hosts.Store(first,2,std::make_shared<const int>(12),4).cached);
  {const auto hot=hosts.Lookup(first,1);ASSERT_TRUE(hot);EXPECT_EQ(*hot,11);}
  EXPECT_TRUE(hosts.Store(second,2,std::make_shared<const int>(22),4).cached);
  EXPECT_FALSE(hosts.Lookup(second,1));
  EXPECT_TRUE(hosts.Lookup(first,1)); EXPECT_TRUE(hosts.Lookup(first,2));
  EXPECT_EQ(hosts.stats().cached_bytes,12u); EXPECT_EQ(hosts.stats().resident_bytes,12u);
  EXPECT_EQ(hosts.stats().encodings,3u); EXPECT_EQ(hosts.stats().evictions,1u);
}

TEST(RemotePaintCaptureHosts, RetiredSnapshotPinsRemainChargedAndCannotOvercommit) {
  CaptureHostRegistry<int> hosts(20,8,20,0);auto owner=hosts.Acquire(1);
  auto first=hosts.Store(owner,1,std::make_shared<const int>(1),4);
  auto second=hosts.Store(owner,2,std::make_shared<const int>(2),4);
  ASSERT_TRUE(first.cached);ASSERT_TRUE(second.cached);
  auto uncached=hosts.Store(owner,3,std::make_shared<const int>(3),4);
  EXPECT_FALSE(uncached.cached);ASSERT_TRUE(uncached.value);EXPECT_EQ(*uncached.value,3);
  EXPECT_EQ(hosts.stats().cached_bytes,0u);EXPECT_EQ(hosts.stats().resident_bytes,8u);
  EXPECT_EQ(hosts.stats().retired_pin_bytes,8u);EXPECT_EQ(hosts.stats().pinned_rejections,1u);
  first.value.reset();EXPECT_EQ(hosts.stats().resident_bytes,4u);
  second.value.reset();EXPECT_EQ(hosts.stats().resident_bytes,0u);
  auto fresh=hosts.Store(owner,4,std::make_shared<const int>(4),8);
  EXPECT_TRUE(fresh.cached);EXPECT_EQ(hosts.stats().peak_resident_bytes,8u);
  auto retired=hosts.Release(1);EXPECT_EQ(hosts.stats().cached_bytes,0u);
  retired.clear();EXPECT_EQ(hosts.stats().resident_bytes,8u);
  fresh.value.reset();EXPECT_EQ(hosts.stats().resident_bytes,0u);
}

TEST(RemotePaintCaptureHosts, ByteCreditReturnsAfterDestructionOutsideTheRegistryLock) {
  struct Payload {
    std::shared_ptr<std::binary_semaphore> started;
    std::shared_ptr<std::binary_semaphore> resume;
    ~Payload(){if(started){started->release();resume->acquire();}}
  };
  auto started=std::make_shared<std::binary_semaphore>(0);
  auto resume=std::make_shared<std::binary_semaphore>(0);
  std::binary_semaphore observed(0);
  CaptureHostRegistry<Payload> hosts(10,8,10,0);auto owner=hosts.Acquire(1);
  auto payload=std::make_shared<Payload>();payload->started=started;payload->resume=resume;
  ASSERT_TRUE(hosts.Store(owner,1,std::move(payload),8).cached);
  bool admitted=false;
  std::thread writer([&]{admitted=hosts.Store(owner,2,std::make_shared<const Payload>(),8).cached;});
  EXPECT_TRUE(started->try_acquire_for(std::chrono::seconds(5)));
  CaptureHostRegistry<Payload>::Stats during{};
  std::thread reader([&]{during=hosts.stats();observed.release();});
  EXPECT_TRUE(observed.try_acquire_for(std::chrono::seconds(5)));
  resume->release();writer.join();reader.join();
  EXPECT_EQ(during.cached_bytes,0u);EXPECT_EQ(during.resident_bytes,8u);
  EXPECT_EQ(during.retired_pin_bytes,8u);EXPECT_TRUE(admitted);
  EXPECT_EQ(hosts.stats().resident_bytes,8u);
}

TEST(RemotePaintCaptureHosts, OversizedAndUntrackedSharedInputsCannotConsumeCredit) {
  CaptureHostRegistry<int> hosts(20,8,20,2);auto owner=hosts.Acquire(1);
  EXPECT_TRUE(hosts.Store(owner,1,std::make_shared<const int>(1),4).cached);
  EXPECT_FALSE(hosts.Store(owner,2,std::make_shared<const int>(2),7).cached);
  EXPECT_FALSE(hosts.Store(owner,3,std::make_shared<const int>(3),std::numeric_limits<size_t>::max()).cached);
  auto shared=std::make_shared<const int>(4);
  EXPECT_FALSE(hosts.Store(owner,4,shared,4).cached);
  EXPECT_TRUE(hosts.Lookup(owner,1));EXPECT_EQ(hosts.stats().resident_bytes,6u);
  EXPECT_EQ(hosts.stats().oversized_rejections,2u);EXPECT_EQ(hosts.stats().shared_rejections,1u);
}

TEST(RemotePaintCaptureHosts, GlobalEntryCapDoesNotMultiplyWithHostCount) {
  CaptureHostRegistry<int> hosts(10,100,2,0);
  for(int n=1;n<=100;n++){
    auto owner=hosts.Acquire(n);EXPECT_TRUE(hosts.Store(owner,1,std::make_shared<const int>(n),1).cached);
    EXPECT_LE(hosts.stats().encodings,2u);EXPECT_LE(hosts.stats().resident_bytes,2u);
  }
  EXPECT_EQ(hosts.stats().hosts,100u);EXPECT_EQ(hosts.stats().evictions,98u);
  for(int n=1;n<=100;n++)hosts.Release(n);
  EXPECT_EQ(hosts.stats().resident_bytes,0u);
}

TEST(RemotePaintCaptureHosts, EncodedFootprintIncludesBase64AndReservedMetadata) {
  EncodedPicture picture;picture.serialized.bytes=SkData::MakeUninitialized(128);
  const auto base=EncodedPictureRetainedBytes(picture);
  const auto base64_capacity=picture.base64.capacity();
  picture.base64.reserve(4096);const auto with_base64=EncodedPictureRetainedBytes(picture);
  EXPECT_GE(with_base64-base,4096u-base64_capacity);
  picture.serialized.asset_ranges.reserve(20);picture.serialized.fonts.reserve(20);
  picture.serialized.fonts.push_back({});picture.serialized.fonts.back().family.reserve(1024);
  const auto with_metadata=EncodedPictureRetainedBytes(picture);
  EXPECT_GE(with_metadata-with_base64,20u*(sizeof(AssetRange)+sizeof(FontStats))+1000u);
  EXPECT_GE(base,128u+sizeof(EncodedPicture));
}

TEST(RemotePaintCaptureMarker, DestroyedHostForgetsItsTagWithoutLosingOtherHosts) {
  CaptureFrameMarkers markers;
  markers.Remember(1, "old", 1); markers.Remember(2, "other", 2);
  markers.Forget(1); markers.Forget(1);
  EXPECT_TRUE(markers.Last(1).empty()); EXPECT_EQ(markers.size(), 1u);
  EXPECT_EQ(ParseCaptureFrameMarker(markers.Last(2))->id, "other");
  markers.Remember(1, "fresh", 3);
  EXPECT_EQ(markers.size(), 2u); EXPECT_EQ(ParseCaptureFrameMarker(markers.Last(1))->id, "fresh");
}

TEST(RemotePaintSerializer, ParallelPicturesEncodeEachFontAndImageOnlyOnce) {
  ASSERT_TRUE(ClearSerializerAssetCachesForTesting());
  auto text = TextPicture("One shared immutable encoding", kTextFamily);
  auto surface = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(256, 256));
  ASSERT_TRUE(surface); surface->getCanvas()->clear(SK_ColorBLUE);
  SkPictureRecorder recorder; auto* canvas = recorder.beginRecording(640, 400);
  canvas->drawPicture(text); canvas->drawImage(surface->makeImageSnapshot(), 0, 100);
  const auto picture = recorder.finishRecordingAsPicture();
  constexpr size_t count = 8;
  std::array<SerializedPicture, count> results;
  std::array<std::thread, count> threads;
  std::latch ready(count), go(1);
  for (size_t n = 0; n < count; n++) threads[n] = std::thread([&, n] {
    ready.count_down(); go.wait(); results[n] = SerializePicture(*picture);
  });
  ready.wait(); go.count_down();
  for (auto& thread : threads) thread.join();
  size_t font_reuse = 0, image_reuse = 0;
  for (const auto& result : results) {
    ASSERT_TRUE(result.bytes) << result.error;
    EXPECT_EQ(result.bytes->size(), results[0].bytes->size());
    EXPECT_EQ(UNSAFE_BUFFERS(std::memcmp(result.bytes->data(), results[0].bytes->data(), result.bytes->size())), 0);
    font_reuse += result.font_cache_hits + result.font_encoding_shares;
    image_reuse += result.image_cache_hits + result.image_encoding_shares;
  }
  EXPECT_EQ(font_reuse, count - 1); EXPECT_EQ(image_reuse, count - 1);
  const auto concurrent = GetSerializerAssetCacheStats();
  EXPECT_EQ(concurrent.font_encodes, 1u); EXPECT_EQ(concurrent.image_encodes, 1u);
  EXPECT_EQ(concurrent.font_pending, 0u); EXPECT_EQ(concurrent.image_pending, 0u);
  EXPECT_TRUE(ClearSerializerAssetCachesForTesting());
}
}  // namespace remote_paint

namespace remote_paint {
namespace {
TEST(RemotePaintCanvas, PixelBoundsMatchExistingSerializerDimensionsAndDecodedLimit) {
 size_t bytes=0;EXPECT_TRUE(CanvasPixelSize(8192,2048,&bytes));EXPECT_EQ(bytes,64u*1024*1024);
 EXPECT_FALSE(CanvasPixelSize(8192,2049,&bytes));EXPECT_FALSE(CanvasPixelSize(8193,1,&bytes));EXPECT_FALSE(CanvasPixelSize(0,64,&bytes));EXPECT_FALSE(CanvasPixelSize(-1,64,&bytes));
}
TEST(RemotePaintCanvas, PixelAdmissionPrecedesStorageAndFinalSkDataAliasReturnsCredit) {
 CanvasPixelPool pool(2048);std::string error;auto data=AllocateCanvasPixels(pool,1024,&error);ASSERT_TRUE(data);EXPECT_EQ(pool.stats().bytes,2048u);EXPECT_EQ(pool.stats().owners,1u);
 auto denied=AllocateCanvasPixels(pool,4,&error);EXPECT_FALSE(denied);EXPECT_EQ(error,kCanvasPixelPressure);EXPECT_EQ(pool.stats().denied,1u);auto alias=data;data.reset();EXPECT_EQ(pool.stats().bytes,2048u);alias.reset();EXPECT_EQ(pool.stats().bytes,0u);EXPECT_EQ(pool.stats().owners,0u);
}
TEST(RemotePaintCanvas, PictureKeepsPixelOwnerAfterInputDataAndImageAreReleased) {
 CanvasPixelPool pool(4096);std::string error;auto data=AllocateCanvasPixels(pool,64,&error);ASSERT_TRUE(data);
 std::array<uint8_t,64> rgba{};for(size_t i=0;i<rgba.size();i+=4){rgba[i]=31;rgba[i+1]=79;rgba[i+2]=191;rgba[i+3]=255;}
 UNSAFE_BUFFERS(std::memcpy(data->writable_data(),rgba.data(),rgba.size()));
 const auto info=SkImageInfo::Make(4,4,kRGBA_8888_SkColorType,kPremul_SkAlphaType,SkColorSpace::MakeSRGB());auto image=SkImages::RasterFromData(info,data,info.minRowBytes());ASSERT_TRUE(image);
 auto picture=CanvasPicture(image,4,4,{0,0,1,1},false,true,SkColors::kTransparent,&error);ASSERT_TRUE(picture);data.reset();image.reset();EXPECT_EQ(pool.stats().bytes,1088u);picture.reset();EXPECT_EQ(pool.stats().bytes,0u);
}
TEST(RemotePaintCanvas, PaddedBgraSharedMemoryConvertsToOwnedRgba) {
 CanvasPixelPool pool(4096);std::string error;std::array<uint8_t,24> bgra={10,20,220,255,30,210,40,255,0,0,0,0,200,50,60,255,70,80,90,255,0,0,0,0};
 const auto source_info=SkImageInfo::Make(2,2,kBGRA_8888_SkColorType,kPremul_SkAlphaType,SkColorSpace::MakeSRGB()),info=source_info.makeColorType(kRGBA_8888_SkColorType);SkPixmap source(source_info,bgra.data(),12);auto pixels=AllocateCanvasPixels(pool,16,&error);ASSERT_TRUE(CopyCanvasPixmap(source,info,pixels.get(),&error));std::array<uint8_t,16> actual{};UNSAFE_BUFFERS(std::memcpy(actual.data(),pixels->data(),actual.size()));EXPECT_EQ(actual,(std::array<uint8_t,16>{220,20,10,255,40,210,30,255,60,50,200,255,90,80,70,255}));
}
TEST(RemotePaintCanvas, UvCropFlipAndBackgroundAreBakedBeforeVizOpacity) {
 auto surface=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(2,2));ASSERT_TRUE(surface);surface->getCanvas()->clear(SK_ColorBLUE);SkPaint paint;paint.setColor(SK_ColorRED);surface->getCanvas()->drawRect(SkRect::MakeXYWH(0,0,1,1),paint);paint.setColor(SK_ColorGREEN);surface->getCanvas()->drawRect(SkRect::MakeXYWH(1,0,1,1),paint);
 std::string error;auto image=surface->makeImageSnapshot();auto picture=CanvasPicture(image,4,4,{.5f,0,1,1},true,true,SkColors::kTransparent,&error);ASSERT_TRUE(picture);auto out=SkSurfaces::Raster(SkImageInfo::MakeN32Premul(4,4));out->getCanvas()->clear(SK_ColorTRANSPARENT);out->getCanvas()->drawPicture(picture);std::array<uint8_t,64> pixels{};ASSERT_TRUE(out->readPixels(SkImageInfo::Make(4,4,kRGBA_8888_SkColorType,kPremul_SkAlphaType),pixels.data(),16,0,0));EXPECT_EQ(pixels[2],255);EXPECT_EQ(pixels[48+1],255);
 EXPECT_FALSE(CanvasPicture(image,4,4,{0,0,0,1},false,true,SkColors::kTransparent,&error));EXPECT_FALSE(CanvasPicture(image,4,4,{0,0,2,1},false,true,SkColors::kTransparent,&error));
}
TEST(RemotePaintCanvas, TransientSnapshotsDoNotEnterLongLivedImageCacheOrPinTheirPixels) {
 ASSERT_TRUE(ClearSerializerAssetCachesForTesting());CanvasPixelPool pool(4096);std::string error;auto pixels=AllocateCanvasPixels(pool,16,&error);std::array<uint8_t,16> input={0,0,128,128,0,0,128,128,0,0,128,128,0,0,128,128};UNSAFE_BUFFERS(std::memcpy(pixels->writable_data(),input.data(),input.size()));const auto info=SkImageInfo::Make(2,2,kRGBA_8888_SkColorType,kPremul_SkAlphaType,SkColorSpace::MakeSRGB());auto image=SkImages::RasterFromData(info,pixels,8);auto picture=CanvasPicture(image,2,2,{0,0,1,1},false,true,SkColors::kWhite,&error);ASSERT_TRUE(picture);auto encoded=SerializePicture(*picture,16*1024*1024,false);ASSERT_TRUE(encoded.bytes)<<encoded.error;EXPECT_TRUE(encoded.asset_ranges_complete);EXPECT_EQ(GetSerializerAssetCacheStats().image_entries,0u);EXPECT_EQ(GetSerializerAssetCacheStats().image_bytes,0u);picture.reset();image.reset();pixels.reset();EXPECT_EQ(pool.stats().bytes,0u);
 SkDeserialProcs procs;procs.fImageProc=[](const void* data,size_t size,std::optional<SkAlphaType> alpha,void*){return SkImages::DeferredFromEncodedData(SkData::MakeWithCopy(data,size),alpha);};auto decoded=SkPicture::MakeFromData(encoded.bytes->data(),encoded.bytes->size(),&procs);ASSERT_TRUE(decoded);auto out=SkSurfaces::Raster(info);out->getCanvas()->clear(SK_ColorTRANSPARENT);out->getCanvas()->drawPicture(decoded);std::array<uint8_t,16> result{};ASSERT_TRUE(out->readPixels(info,result.data(),8,0,0));EXPECT_NEAR(result[0],127,1);EXPECT_NEAR(result[1],127,1);EXPECT_EQ(result[2],255);EXPECT_EQ(result[3],255);
}
TEST(RemotePaintCanvas, ConcurrentLeasesNeverExceedPoolAndReturnAfterActualOwnersDrop) {
 CanvasPixelPool pool(4096);std::latch ready(8),release(1);std::array<std::thread,8> jobs;for(size_t i=0;i<jobs.size();i++)jobs[i]=std::thread([&]{std::string error;auto data=AllocateCanvasPixels(pool,1024,&error);ready.count_down();release.wait();});ready.wait();EXPECT_EQ(pool.stats().bytes,4096u);EXPECT_EQ(pool.stats().owners,2u);EXPECT_EQ(pool.stats().denied,6u);release.count_down();for(auto& job:jobs)job.join();EXPECT_EQ(pool.stats().bytes,0u);
}
}  // namespace
}  // namespace remote_paint

namespace remote_paint {
TEST(RemotePaintRecordingBefore, PictureApproximationDoesNotPriceItsRetainedImage) {
 CanvasPixelPool pool(8*1024*1024);std::string error;auto pixels=AllocateCanvasPixels(pool,4*1024*1024,&error);ASSERT_TRUE(pixels);
 const auto info=SkImageInfo::Make(1024,1024,kRGBA_8888_SkColorType,kPremul_SkAlphaType,SkColorSpace::MakeSRGB());
 auto image=SkImages::RasterFromData(info,pixels,info.minRowBytes());auto picture=CanvasPicture(image,1024,1024,{0,0,1,1},false,true,SkColors::kTransparent,&error);ASSERT_TRUE(picture);
 const auto shallow=picture->approximateBytesUsed();std::map<int,sk_sp<SkPicture>> legacy;legacy.emplace(1,picture);pixels.reset();image.reset();picture.reset();
 EXPECT_LT(shallow,64u*1024);EXPECT_EQ(pool.stats().bytes,4u*1024*1024+1024);printf("recording-before: picture_approx=%zu retained_pixel_bytes=%zu raw_cache_entries=%zu\n",shallow,pool.stats().bytes,legacy.size());
 legacy.clear();EXPECT_EQ(pool.stats().bytes,0u);
}
}

namespace remote_paint {
TEST(RemotePaintRecordingIndex, FixedBackingIsAdmittedAndFinalCacheAliasReturnsCredit) {
 RecordingIndexPool pool(kRecordingIndexCharge);auto cache=pool.CreateCache();ASSERT_TRUE(cache);EXPECT_LE(RecordingKeyCache::BackingBytes()+sizeof(RecordingKeyCache)+1024,kRecordingIndexCharge);
 EXPECT_EQ(pool.stats().bytes,kRecordingIndexCharge);EXPECT_EQ(pool.stats().caches,1u);EXPECT_FALSE(pool.CreateCache());EXPECT_EQ(pool.stats().denied,1u);
 auto alias=cache;cache.reset();EXPECT_EQ(pool.stats().bytes,kRecordingIndexCharge);alias.reset();EXPECT_EQ(pool.stats().bytes,0u);EXPECT_EQ(pool.stats().caches,0u);
 ASSERT_TRUE(pool.CreateCache());RecordingIndexPool too_small(kRecordingIndexCharge-1);EXPECT_FALSE(too_small.CreateCache());EXPECT_EQ(too_small.stats().bytes,0u);
}
TEST(RemotePaintRecordingIndex, GenerationExtentAndDamageFenceEveryEncodingKey) {
 RecordingIndexPool pool(kRecordingIndexCharge);auto cache=pool.CreateCache();ASSERT_TRUE(cache);cache->BeginCapture();cache->Put(7,0,0,11,512,256,101);
 EXPECT_EQ(cache->Reusable(7,0,0,11,512,256,false,false),101u);
 EXPECT_FALSE(cache->Reusable(7,0,0,12,512,256,false,false));EXPECT_FALSE(cache->Reusable(7,0,0,11,768,256,true,false));
 EXPECT_FALSE(cache->Reusable(7,0,0,11,512,256,true,true));EXPECT_FALSE(cache->Reusable(7,0,0,0,512,256,true,false));
 EXPECT_EQ(cache->Reusable(7,0,0,12,512,256,true,false),101u);
 cache->Put(7,0,0,12,512,256,101);cache->EndCapture(true);cache->BeginCapture();EXPECT_EQ(cache->Reusable(7,0,0,12,512,256,false,false),101u);
 EXPECT_FALSE(cache->Reusable(8,0,0,12,512,256,true,false));EXPECT_FALSE(cache->Reusable(7,-1,-1,12,512,256,true,false));
}
TEST(RemotePaintRecordingIndex, BoundedLruCollisionLookupAndSuccessfulFramePruning) {
 RecordingIndexPool pool(kRecordingIndexCharge);auto cache=pool.CreateCache();ASSERT_TRUE(cache);cache->BeginCapture();
 for(int n=0;n<1024;n++)cache->Put(n,256*(n%32),256*(n/32),1,8192,8192,1000+n);
 EXPECT_EQ(cache->size(),1024u);
 for(int n=0;n<1024;n++)EXPECT_EQ(cache->Reusable(n,256*(n%32),256*(n/32),1,8192,8192,false,false),static_cast<uint64_t>(1000+n));
 cache->Put(0,0,0,1,8192,8192,1000);cache->Put(2000,0,0,1,8192,8192,9000);
 EXPECT_TRUE(cache->Reusable(0,0,0,1,8192,8192,false,false));EXPECT_FALSE(cache->Reusable(1,256,0,1,8192,8192,false,false));EXPECT_EQ(cache->size(),1024u);
 cache->EndCapture(true);cache->BeginCapture();cache->Put(0,0,0,1,8192,8192,1000);cache->EndCapture(true);EXPECT_EQ(cache->size(),1u);EXPECT_EQ(pool.stats().bytes,kRecordingIndexCharge);
 cache->BeginCapture();cache->Put(7,0,0,2,32,32,7000);cache->EndCapture(false);EXPECT_EQ(cache->size(),2u);
 cache->BeginCapture();cache->Put(7,0,0,2,32,32,7000);cache->EndCapture(true);EXPECT_EQ(cache->size(),1u);EXPECT_FALSE(cache->Reusable(0,0,0,1,8192,8192,false,false));
}
TEST(RemotePaintRecordingIndex, ScalarKeysDoNotPinExternalPictureImagePixels) {
 RecordingIndexPool index_pool(kRecordingIndexCharge);auto cache=index_pool.CreateCache();ASSERT_TRUE(cache);
 CanvasPixelPool pixels_pool(8*1024*1024);std::string error;auto pixels=AllocateCanvasPixels(pixels_pool,4*1024*1024,&error);ASSERT_TRUE(pixels);
 const auto info=SkImageInfo::Make(1024,1024,kRGBA_8888_SkColorType,kPremul_SkAlphaType,SkColorSpace::MakeSRGB());auto image=SkImages::RasterFromData(info,pixels,info.minRowBytes());auto picture=CanvasPicture(image,1024,1024,{0,0,1,1},false,true,SkColors::kTransparent,&error);ASSERT_TRUE(picture);
 cache->BeginCapture();cache->Put(1,-1,-1,10,1024,1024,500);cache->EndCapture(true);pixels.reset();image.reset();EXPECT_EQ(pixels_pool.stats().bytes,4u*1024*1024+1024);
 picture.reset();EXPECT_EQ(pixels_pool.stats().bytes,0u);EXPECT_EQ(cache->size(),1u);EXPECT_EQ(index_pool.stats().bytes,kRecordingIndexCharge);
 printf("recording-after: cached_keys=%zu retained_pixel_bytes=%zu index_credit=%zu backing=%zu\n",cache->size(),pixels_pool.stats().bytes,index_pool.stats().bytes,RecordingKeyCache::BackingBytes());
}
TEST(RemotePaintRecordingIndex, ConcurrentCacheAdmissionIsBoundedAndRecoversAfterActualOwners) {
 RecordingIndexPool pool(2*kRecordingIndexCharge);std::latch ready(8),release(1);std::array<std::thread,8> jobs;
 for(auto& job:jobs)job=std::thread([&]{auto cache=pool.CreateCache();ready.count_down();release.wait();});
 ready.wait();EXPECT_EQ(pool.stats().bytes,2*kRecordingIndexCharge);EXPECT_EQ(pool.stats().caches,2u);EXPECT_EQ(pool.stats().denied,6u);EXPECT_EQ(pool.stats().peak,2*kRecordingIndexCharge);release.count_down();for(auto& job:jobs)job.join();EXPECT_EQ(pool.stats().bytes,0u);
 auto recovered=pool.CreateCache();ASSERT_TRUE(recovered);EXPECT_EQ(pool.stats().bytes,kRecordingIndexCharge);
}

namespace {
using Sub=SubscriptionState;
Sub::Key SubKey(char last='a') {auto text=std::string(32,'a');text.back()=last;return *Sub::Key::Parse(text);}
Sub::Context SubContext(uint64_t input=0) {return {1,1,input,960,640};}
Sub::Ticket SubTake(Sub& book,int host) {auto take=book.Take(host);EXPECT_EQ(take.status,Sub::TakeStatus::Taken);return take.ticket.value();}
void SubConsume(Sub& book,const Sub::Ticket& ticket) {ASSERT_TRUE(book.BeginPublish(ticket));EXPECT_EQ(book.Finish(ticket,Sub::Outcome::Consumed),Sub::Completion::Released);}
}
TEST(RemotePaintSubscription, FixedSlotsValidateBeforeMutatingReservations) {
 Sub book;EXPECT_LE(sizeof(book),2048u);EXPECT_EQ(book.stats().bindings,0u);
 EXPECT_FALSE(Sub::Key::Parse("short"));EXPECT_FALSE(Sub::Key::Parse(std::string(32,'A')));
 auto bad=SubContext();bad.css_width=4097;
 EXPECT_EQ(book.Bind(1,SubKey(),bad).status,Sub::BindStatus::Invalid);
 EXPECT_EQ(book.Bind(0,SubKey(),SubContext()).status,Sub::BindStatus::Invalid);
 EXPECT_EQ(book.Bind(1,Sub::Key{},SubContext()).status,Sub::BindStatus::Invalid);
 EXPECT_EQ(book.stats().next_base,0u);
 for(int n=0;n<4;n++)EXPECT_EQ(book.Bind(n+1,SubKey('a'+n),SubContext()).status,Sub::BindStatus::Bound);
 const auto reserved=book.stats().next_base;EXPECT_EQ(book.Bind(5,SubKey('e'),SubContext()).status,Sub::BindStatus::Full);
 EXPECT_EQ(book.stats().next_base,reserved);EXPECT_EQ(book.stats().bindings,4u);
}
TEST(RemotePaintSubscription, TargetBindingAndRetryAreIdempotentWithoutWatermarkRollback) {
 Sub book;const auto first=book.Bind(1,SubKey(),SubContext());ASSERT_TRUE(first.snapshot);
 EXPECT_FALSE(first.snapshot->enabled);EXPECT_EQ(book.Take(1).status,Sub::TakeStatus::Inactive);
 EXPECT_TRUE(book.Update(1,SubKey(),7,false));const auto next=book.stats().next_base;
 auto repeated=book.Bind(1,SubKey(),SubContext());ASSERT_EQ(repeated.status,Sub::BindStatus::Existing);
 EXPECT_EQ(repeated.snapshot->context.input_seq,7u);EXPECT_EQ(book.stats().next_base,next);
 EXPECT_FALSE(book.Update(1,SubKey(),6,false));EXPECT_FALSE(book.Update(1,SubKey(),Sub::kMaxSafeInteger+1,false));
 auto changed=SubContext();changed.viewport_version++;
 EXPECT_EQ(book.Bind(1,SubKey(),changed).status,Sub::BindStatus::Busy);
 EXPECT_EQ(book.Bind(2,SubKey(),SubContext()).status,Sub::BindStatus::Busy);
 EXPECT_EQ(book.Bind(1,SubKey('b'),SubContext()).status,Sub::BindStatus::Busy);
}
TEST(RemotePaintSubscription, FrameCreditAndContextAreCapturedBeforeLaterInput) {
 Sub book;book.Bind(1,SubKey(),SubContext(7));ASSERT_TRUE(book.SetEnabled(1,SubKey(),true));
 auto ticket=SubTake(book,1);EXPECT_EQ(ticket.context.input_seq,7u);
 for(int n=0;n<100;n++)EXPECT_EQ(book.Take(1).status,Sub::TakeStatus::Busy);
 EXPECT_TRUE(book.Update(1,SubKey(),9,false));EXPECT_EQ(ticket.context.input_seq,7u);
 EXPECT_EQ(book.Inspect(1,SubKey())->last_started,ticket.ordinal);
 EXPECT_EQ(book.Finish(ticket,Sub::Outcome::Consumed),Sub::Completion::Ignored);
 EXPECT_EQ(book.stats().inflight,1u);SubConsume(book,ticket);
 auto next=SubTake(book,1);EXPECT_EQ(next.context.input_seq,9u);EXPECT_GT(next.ordinal,ticket.ordinal);
 EXPECT_EQ(book.Finish(ticket,Sub::Outcome::Retry),Sub::Completion::Ignored);
 EXPECT_EQ(book.stats().inflight,1u);EXPECT_EQ(book.Finish(next,Sub::Outcome::Retry),Sub::Completion::Released);
}
TEST(RemotePaintSubscription, CaptureStartBelongsToTheAdmittedJobAcrossBusyInputAndRetry) {
 Sub book;book.Bind(1,SubKey(),SubContext(7));book.SetEnabled(1,SubKey(),true);
 auto first=book.Take(1,12,true,1'234'567);ASSERT_TRUE(first.ticket);
 EXPECT_EQ(first.ticket->capture_started_us,1'234'567u);
 EXPECT_EQ(book.Inspect(1,SubKey())->last_started_us,first.ticket->capture_started_us);
 EXPECT_EQ(book.Take(1,12,true,1'400'000).status,Sub::TakeStatus::Busy);
 ASSERT_TRUE(book.Update(1,SubKey(),9,false,true,12,1'500'000));
 EXPECT_EQ(first.ticket->capture_started_us,1'234'567u);EXPECT_EQ(first.ticket->context.input_seq,7u);
 EXPECT_EQ(book.Inspect(1,SubKey())->last_started_us,1'234'567u);SubConsume(book,*first.ticket);
 auto second=book.Take(1,12,true,1'800'000);ASSERT_TRUE(second.ticket);
 EXPECT_EQ(second.ticket->capture_started_us,1'800'000u);EXPECT_EQ(second.ticket->context.input_seq,9u);
 EXPECT_GT(second.ticket->ordinal,first.ticket->ordinal);
 EXPECT_EQ(book.Finish(*second.ticket,Sub::Outcome::Retry,1'900'000),Sub::Completion::Released);
 EXPECT_EQ(second.ticket->capture_started_us,1'800'000u);
 auto retried=book.Take(1,12,true,2'000'000);ASSERT_TRUE(retried.ticket);
 EXPECT_EQ(retried.ticket->capture_started_us,2'000'000u);EXPECT_GT(retried.ticket->ordinal,second.ticket->ordinal);
}
TEST(RemotePaintSubscription, FailedAdmissionAndRetirementCannotLeakOrRetimeCaptureStarts) {
 Sub book;book.Bind(1,SubKey(),SubContext(),0,12);
 EXPECT_EQ(book.Take(1,12,true,100).status,Sub::TakeStatus::Inactive);
 book.SetEnabled(1,SubKey(),true);EXPECT_EQ(book.Take(1,11,true,200).status,Sub::TakeStatus::BeforeCommit);
 EXPECT_EQ(book.Inspect(1,SubKey())->last_started_us,0u);
 auto first=book.Take(1,12,true,300);ASSERT_TRUE(first.ticket);EXPECT_EQ(first.ticket->capture_started_us,300u);
 book.Bind(2,SubKey('b'),SubContext());book.SetEnabled(2,SubKey('b'),true);
 auto other=book.Take(2,0,true,400);ASSERT_TRUE(other.ticket);EXPECT_EQ(other.ticket->capture_started_us,400u);
 book.Cancel(1,SubKey());EXPECT_EQ(book.Finish(*first.ticket,Sub::Outcome::Retry,500),Sub::Completion::Retired);
 SubConsume(book,*other.ticket);ASSERT_TRUE(book.Bind(1,SubKey('c'),SubContext()).snapshot);book.SetEnabled(1,SubKey('c'),true);
 auto rebound=book.Take(1,0,true,600);ASSERT_TRUE(rebound.ticket);EXPECT_EQ(rebound.ticket->capture_started_us,600u);
 EXPECT_EQ(first.ticket->capture_started_us,300u);EXPECT_GT(rebound.ticket->ordinal,first.ticket->ordinal);
 EXPECT_EQ(book.Finish(*first.ticket,Sub::Outcome::Consumed,700),Sub::Completion::Ignored);
 EXPECT_EQ(book.Inspect(1,SubKey('c'))->last_started_us,600u);
}
TEST(RemotePaintSubscription, NewFullResourceRequestSurvivesAnOlderCredit) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);
 auto first=SubTake(book,1);ASSERT_TRUE(first.full_resources);EXPECT_TRUE(book.BeginPublish(first));
 ASSERT_TRUE(book.Update(1,SubKey(),1,true));EXPECT_EQ(book.Finish(first,Sub::Outcome::Consumed),Sub::Completion::Released);
 EXPECT_TRUE(book.Inspect(1,SubKey())->full_resources);EXPECT_TRUE(book.Inspect(1,SubKey())->needs_frame);
 auto next=SubTake(book,1);EXPECT_TRUE(next.full_resources);SubConsume(book,next);
 EXPECT_FALSE(book.Inspect(1,SubKey())->full_resources);
 auto cached=SubTake(book,1);EXPECT_FALSE(cached.full_resources);SubConsume(book,cached);
}
TEST(RemotePaintSubscription, PauseRejectsPublicationAndRequiresFullResourcesOnResume) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);
 auto ticket=SubTake(book,1);ASSERT_TRUE(book.SetEnabled(1,SubKey(),false));EXPECT_FALSE(book.BeginPublish(ticket));
 EXPECT_EQ(book.Take(1).status,Sub::TakeStatus::Inactive);EXPECT_EQ(book.stats().inflight,1u);
 EXPECT_EQ(book.Finish(ticket,Sub::Outcome::Retry),Sub::Completion::Released);
 EXPECT_FALSE(book.Inspect(1,SubKey())->needs_frame);ASSERT_TRUE(book.SetEnabled(1,SubKey(),true));
 auto resumed=SubTake(book,1);EXPECT_TRUE(resumed.full_resources);SubConsume(book,resumed);
 auto paused=SubTake(book,1);ASSERT_TRUE(book.BeginPublish(paused));EXPECT_EQ(book.Finish(paused,Sub::Outcome::Pause),Sub::Completion::Released);
 EXPECT_FALSE(book.Inspect(1,SubKey())->enabled);EXPECT_TRUE(book.Inspect(1,SubKey())->full_resources);
}
TEST(RemotePaintSubscription, CancelPinsOnlyTheExactOutstandingSlotUntilLateCompletion) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto original=*book.Inspect(1,SubKey());auto old=SubTake(book,1);
 EXPECT_TRUE(book.Cancel(1,SubKey()));EXPECT_TRUE(book.Inspect(1,SubKey())->retiring);EXPECT_FALSE(book.BeginPublish(old));EXPECT_FALSE(book.SetEnabled(1,SubKey(),true));
 EXPECT_EQ(book.Bind(1,SubKey('b'),SubContext()).status,Sub::BindStatus::Busy);
 EXPECT_EQ(book.Finish(old,Sub::Outcome::Retry),Sub::Completion::Retired);EXPECT_EQ(book.stats().bindings,0u);
 auto rebound=book.Bind(1,SubKey('b'),SubContext());ASSERT_EQ(rebound.status,Sub::BindStatus::Bound);EXPECT_GT(rebound.snapshot->ordinal_base,original.ordinal_limit);
 book.SetEnabled(1,SubKey('b'),true);auto current=SubTake(book,1);EXPECT_FALSE(book.BeginPublish(old));EXPECT_EQ(book.Finish(old,Sub::Outcome::Retry),Sub::Completion::Ignored);EXPECT_EQ(book.stats().inflight,1u);SubConsume(book,current);
}
TEST(RemotePaintSubscription, HostRetirementDoesNotReleaseAnotherHostsCredit) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.Bind(2,SubKey('b'),SubContext());book.SetEnabled(1,SubKey(),true);book.SetEnabled(2,SubKey('b'),true);
 auto first=SubTake(book,1),second=SubTake(book,2);EXPECT_TRUE(book.BeginPublish(first));EXPECT_TRUE(book.RetireHost(1));
 EXPECT_EQ(book.stats().retiring,1u);EXPECT_EQ(book.Finish(first,Sub::Outcome::Consumed),Sub::Completion::Retired);EXPECT_EQ(book.stats().inflight,1u);EXPECT_TRUE(book.HasHost(2));SubConsume(book,second);
 EXPECT_TRUE(book.RetireHost(2));EXPECT_EQ(book.stats().bindings,0u);EXPECT_FALSE(book.RetireHost(2));
}
TEST(RemotePaintSubscription, CanceledJobsKeepCapacityBoundedUntilActualCredit) {
 Sub book;std::array<Sub::Ticket,4> tickets;
 for(int n=0;n<4;n++){book.Bind(n+1,SubKey('a'+n),SubContext());book.SetEnabled(n+1,SubKey('a'+n),true);tickets[n]=SubTake(book,n+1);book.Cancel(n+1,SubKey('a'+n));}
 EXPECT_EQ(book.stats().retiring,4u);EXPECT_EQ(book.Bind(5,SubKey('e'),SubContext()).status,Sub::BindStatus::Full);
 EXPECT_EQ(book.Finish(tickets[2],Sub::Outcome::Retry),Sub::Completion::Retired);EXPECT_EQ(book.Bind(5,SubKey('e'),SubContext()).status,Sub::BindStatus::Bound);
 EXPECT_EQ(book.Finish(tickets[2],Sub::Outcome::Retry),Sub::Completion::Ignored);EXPECT_EQ(book.stats().bindings,4u);
}
TEST(RemotePaintSubscription, ReservationFenceSurvivesRendererReplacementAndAlignment) {
 Sub old(16);auto first=old.Bind(1,SubKey(),SubContext());ASSERT_TRUE(first.snapshot);old.SetEnabled(1,SubKey(),true);auto in_flight=SubTake(old,1);
 Sub replacement(16);auto bound=replacement.Bind(1,SubKey('b'),SubContext(),first.snapshot->ordinal_limit+1);ASSERT_TRUE(bound.snapshot);EXPECT_GT(bound.snapshot->ordinal_base,in_flight.ordinal);EXPECT_GT(bound.snapshot->ordinal_base,first.snapshot->ordinal_limit);
 Sub aligned(16);auto rounded=aligned.Bind(1,SubKey(),SubContext(),19);ASSERT_TRUE(rounded.snapshot);EXPECT_EQ(rounded.snapshot->ordinal_base,32u);EXPECT_EQ(rounded.snapshot->ordinal_limit,47u);
}
TEST(RemotePaintSubscription, LocalOrdinalExhaustionFailsClosedWithoutReusingAFrameId) {
 Sub book(4);book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);
 for(uint64_t expected=1;expected<=3;expected++){auto ticket=SubTake(book,1);EXPECT_EQ(ticket.ordinal,expected);SubConsume(book,ticket);}
 EXPECT_EQ(book.Take(1).status,Sub::TakeStatus::Exhausted);EXPECT_FALSE(book.Inspect(1,SubKey())->enabled);EXPECT_TRUE(book.Inspect(1,SubKey())->exhausted);EXPECT_FALSE(book.SetEnabled(1,SubKey(),true));
}
TEST(RemotePaintSubscription, JsSafeRangeExhaustionAndInvalidConfigurationDoNotWrap) {
 Sub book;const auto last_base=Sub::kMaxSafeInteger-(Sub::kDefaultOrdinalSpan-1);auto last=book.Bind(1,SubKey(),SubContext(),last_base);ASSERT_TRUE(last.snapshot);EXPECT_EQ(last.snapshot->ordinal_limit,Sub::kMaxSafeInteger);
 EXPECT_EQ(book.Bind(2,SubKey('b'),SubContext()).status,Sub::BindStatus::Exhausted);EXPECT_EQ(book.stats().bindings,1u);
 Sub rounded;EXPECT_EQ(rounded.Bind(1,SubKey(),SubContext(),Sub::kMaxSafeInteger).status,Sub::BindStatus::Exhausted);EXPECT_EQ(rounded.stats().bindings,0u);
 Sub invalid(3);EXPECT_EQ(invalid.Bind(1,SubKey(),SubContext()).status,Sub::BindStatus::Invalid);
}
TEST(RemotePaintSubscription, CorruptedAndDuplicateCreditsCannotAdvanceTheCurrentJob) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);auto original=SubTake(book,1);ASSERT_TRUE(book.BeginPublish(original));
 for(int field=0;field<5;field++){auto bad=original;if(field==0)bad.ordinal++;if(field==1)bad.generation++;if(field==2)bad.host++;if(field==3)bad.key=SubKey('b');if(field==4)bad.slot=255;EXPECT_EQ(book.Finish(bad,Sub::Outcome::Consumed),Sub::Completion::Ignored);EXPECT_EQ(book.stats().inflight,1u);}
 EXPECT_EQ(book.Finish(original,Sub::Outcome::Consumed),Sub::Completion::Released);EXPECT_EQ(book.Finish(original,Sub::Outcome::Consumed),Sub::Completion::Ignored);
}

TEST(RemotePaintSubscriptionCredit, EveryOutcomeRoundTripsExactNativeIdentity) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto ticket=SubTake(book,1);
 for(auto outcome:{Sub::Outcome::Consumed,Sub::Outcome::Retry,Sub::Outcome::Pause}) {
   const auto bytes=MakeSubscriptionCredit(ticket,outcome);
   const auto parsed=ParseSubscriptionCredit({bytes.data(),bytes.size()},ticket);
   ASSERT_TRUE(parsed);EXPECT_EQ(*parsed,outcome);
 }
}
TEST(RemotePaintSubscriptionCredit, CaptureClockMetadataDoesNotChangeThe56ByteIdentityReceipt) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);auto ticket=SubTake(book,1);
 const auto original=MakeSubscriptionCredit(ticket,Sub::Outcome::Consumed);ASSERT_EQ(original.size(),56u);
 for(uint64_t stamp:{uint64_t{0},uint64_t{1},Sub::kMaxSafeInteger,std::numeric_limits<uint64_t>::max()}) {
   ticket.capture_started_us=stamp;EXPECT_EQ(MakeSubscriptionCredit(ticket,Sub::Outcome::Consumed),original);
   EXPECT_EQ(ParseSubscriptionCredit({original.data(),original.size()},ticket),Sub::Outcome::Consumed);
 }
}
TEST(RemotePaintSubscriptionCredit, AnyChangedByteFailsClosed) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto ticket=SubTake(book,1);
 const auto correct=MakeSubscriptionCredit(ticket,Sub::Outcome::Consumed);
 for(size_t i=0;i<correct.size();++i) {
   auto corrupt=correct;corrupt[i]^=0x40;
   EXPECT_FALSE(ParseSubscriptionCredit({corrupt.data(),corrupt.size()},ticket))<<i;
 }
}
TEST(RemotePaintSubscriptionCredit, TruncatedAndExtendedReceiptsAreRejected) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto ticket=SubTake(book,1);
 const auto correct=MakeSubscriptionCredit(ticket,Sub::Outcome::Consumed);
 for(size_t n=0;n<correct.size();++n)EXPECT_FALSE(ParseSubscriptionCredit({correct.data(),n},ticket));
 std::string extended(correct.data(),correct.size());extended.push_back(0);EXPECT_FALSE(ParseSubscriptionCredit(extended,ticket));
}
TEST(RemotePaintSubscriptionCredit, OtherScopeGenerationAndOrdinalCannotReleaseThisJob) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto ticket=SubTake(book,1);
 for(int field=0;field<3;++field) {
   auto other=ticket;if(field==0)other.key=SubKey('b');if(field==1)other.generation++;if(field==2)other.ordinal++;
   const auto wrong=MakeSubscriptionCredit(other,Sub::Outcome::Consumed);
   EXPECT_FALSE(ParseSubscriptionCredit({wrong.data(),wrong.size()},ticket));
 }
}

TEST(RemotePaintSubscription, InputAndDocumentContextWaitsForItsMainThreadCommit) {
 Sub book;ASSERT_TRUE(book.Bind(1,SubKey(),SubContext(),0,10).snapshot);book.SetEnabled(1,SubKey(),true,10);
 EXPECT_EQ(book.Take(1,9).status,Sub::TakeStatus::BeforeCommit);EXPECT_EQ(book.Inspect(1,SubKey())->last_started,0u);
 auto taken=book.Take(1,10);ASSERT_TRUE(taken.ticket);EXPECT_EQ(taken.ticket->context.input_seq,0u);
 ASSERT_TRUE(book.Update(1,SubKey(),7,false,true,12));SubConsume(book,*taken.ticket);
 EXPECT_EQ(book.Take(1,11).status,Sub::TakeStatus::BeforeCommit);EXPECT_EQ(book.Inspect(1,SubKey())->last_started,1u);
 auto fresh=book.Take(1,12);ASSERT_TRUE(fresh.ticket);EXPECT_EQ(fresh.ticket->context.input_seq,7u);SubConsume(book,*fresh.ticket);
 // Compositor-only animation keeps using this tree without more main commits.
 auto animation=book.Take(1,12);ASSERT_TRUE(animation.ticket);SubConsume(book,*animation.ticket);
}
TEST(RemotePaintSubscription, ResumeCommitFenceIsMonotonicAndInvalidFencesFailClosed) {
 Sub book;book.Bind(1,SubKey(),SubContext(),0,4);book.SetEnabled(1,SubKey(),true,8);
 EXPECT_EQ(book.Take(1,7).status,Sub::TakeStatus::BeforeCommit);
 ASSERT_TRUE(book.Update(1,SubKey(),1,false,true,6));EXPECT_EQ(book.Inspect(1,SubKey())->minimum_source_frame,8);
 EXPECT_FALSE(book.Update(1,SubKey(),2,true,true,-1));EXPECT_EQ(book.Inspect(1,SubKey())->context.input_seq,1u);
 EXPECT_FALSE(book.SetEnabled(1,SubKey(),true,-1));EXPECT_EQ(book.Inspect(1,SubKey())->minimum_source_frame,8);
 book.SetEnabled(1,SubKey(),false);book.SetEnabled(1,SubKey(),true,12);
 EXPECT_EQ(book.Take(1,11).status,Sub::TakeStatus::BeforeCommit);EXPECT_TRUE(book.Take(1,12).ticket);
 EXPECT_EQ(book.Bind(2,SubKey('b'),SubContext(),0,-1).status,Sub::BindStatus::Invalid);
}

TEST(RemotePaintSubscriptionCadence, ValidationKeepsFixedBookAndDiagnosticBehavior) {
 Sub book;book.Bind(1,SubKey(),SubContext());EXPECT_LE(sizeof(book),2048u);
 EXPECT_FALSE(book.SetCadence(1,SubKey(),1,0));EXPECT_FALSE(book.SetCadence(1,SubKey(),101,100));
 EXPECT_FALSE(book.SetCadence(1,SubKey(),0,1'000'001));EXPECT_FALSE(book.SetCadence(2,SubKey(),0,100));
 book.SetEnabled(1,SubKey(),true);auto first=book.Take(1,0,false,100);ASSERT_TRUE(first.ticket);SubConsume(book,*first.ticket);
 EXPECT_FALSE(book.NextDelay(100));EXPECT_TRUE(book.Take(1,0,false,100).ticket);
}
TEST(RemotePaintSubscriptionCadence, LoneThrottledDamageIsLatchedUntilEligibleDeadline) {
 Sub book;book.Bind(1,SubKey(),SubContext());ASSERT_TRUE(book.SetCadence(1,SubKey(),100,1000));book.SetEnabled(1,SubKey(),true);
 auto first=book.Take(1,0,false,0);ASSERT_TRUE(first.ticket);SubConsume(book,*first.ticket);
 auto damage=book.Take(1,0,true,10);EXPECT_EQ(damage.status,Sub::TakeStatus::NotDue);EXPECT_TRUE(damage.schedule_changed);
 EXPECT_EQ(book.NextDelay(10),90u);EXPECT_FALSE(book.RequestDue(1,SubKey(),99));EXPECT_TRUE(book.RequestDue(1,SubKey(),100));
 auto delayed=book.Take(1,0,false,100);ASSERT_TRUE(delayed.ticket);EXPECT_EQ(delayed.ticket->ordinal,2u);SubConsume(book,*delayed.ticket);
 EXPECT_FALSE(book.Inspect(1,SubKey())->pending_damage);EXPECT_EQ(book.NextDelay(101),999u);
}
TEST(RemotePaintSubscriptionCadence, HeartbeatAndExactIntervalUseMonotonicSafeArithmetic) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetCadence(1,SubKey(),100,1000);book.SetEnabled(1,SubKey(),true);
 auto first=book.Take(1,0,false,500);ASSERT_TRUE(first.ticket);SubConsume(book,*first.ticket);
 EXPECT_EQ(book.Take(1,0,true,599).status,Sub::TakeStatus::NotDue);auto boundary=book.Take(1,0,true,600);ASSERT_TRUE(boundary.ticket);SubConsume(book,*boundary.ticket);
 EXPECT_EQ(book.NextDelay(500),1000u);EXPECT_FALSE(book.RequestDue(1,SubKey(),1599));EXPECT_TRUE(book.RequestDue(1,SubKey(),1600));
 auto heartbeat=book.Take(1,0,false,1600);ASSERT_TRUE(heartbeat.ticket);SubConsume(book,*heartbeat.ticket);
 auto urgent=book.Update(1,SubKey(),0,false,true);ASSERT_TRUE(urgent);auto near_limit=book.Take(1,0,false,std::numeric_limits<uint64_t>::max()-10);ASSERT_TRUE(near_limit.ticket);SubConsume(book,*near_limit.ticket);
 EXPECT_EQ(book.NextDelay(std::numeric_limits<uint64_t>::max()),990u);
}
TEST(RemotePaintSubscriptionCadence, DamageWhileAwaitingCreditSurvivesConsumed) {
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetCadence(1,SubKey(),100,1000);book.SetEnabled(1,SubKey(),true);
 auto first=book.Take(1,0,false,0);ASSERT_TRUE(first.ticket);ASSERT_TRUE(book.BeginPublish(*first.ticket));
 auto busy=book.Take(1,0,true,10);EXPECT_EQ(busy.status,Sub::TakeStatus::Busy);EXPECT_TRUE(busy.schedule_changed);
 EXPECT_FALSE(book.NextDelay(20));EXPECT_FALSE(book.RequestDue(1,SubKey(),1000));
 EXPECT_EQ(book.Finish(*first.ticket,Sub::Outcome::Consumed),Sub::Completion::Released);EXPECT_EQ(book.NextDelay(50),50u);
 ASSERT_TRUE(book.RequestDue(1,SubKey(),100));auto changed=book.Take(1,0,false,100);ASSERT_TRUE(changed.ticket);EXPECT_FALSE(changed.ticket->full_resources);SubConsume(book,*changed.ticket);
}
TEST(RemotePaintSubscriptionCadence, UrgentInputBypassesIntervalButNotCommitFloor) {
 Sub book;book.Bind(1,SubKey(),SubContext(),0,2);book.SetCadence(1,SubKey(),100,1000);book.SetEnabled(1,SubKey(),true);
 auto first=book.Take(1,2,false,0);ASSERT_TRUE(first.ticket);SubConsume(book,*first.ticket);
 ASSERT_TRUE(book.Update(1,SubKey(),7,false,true,3));EXPECT_EQ(book.Take(1,2,true,1).status,Sub::TakeStatus::BeforeCommit);
 auto input=book.Take(1,3,false,2);ASSERT_TRUE(input.ticket);EXPECT_EQ(input.ticket->context.input_seq,7u);SubConsume(book,*input.ticket);
}
TEST(RemotePaintSubscriptionCadence, PauseRetirementAndMultipleBindingsBoundDeadlines) {
 Sub book;for(int n=1;n<=4;n++){book.Bind(n,SubKey('a'+n-1),SubContext());ASSERT_TRUE(book.SetCadence(n,SubKey('a'+n-1),10,100*n));book.SetEnabled(n,SubKey('a'+n-1),true);auto first=book.Take(n,0,false,0);ASSERT_TRUE(first.ticket);SubConsume(book,*first.ticket);}
 EXPECT_EQ(book.NextDelay(10),90u);book.SetEnabled(1,SubKey(),false);EXPECT_EQ(book.NextDelay(10),190u);
 EXPECT_FALSE(book.RequestDue(1,SubKey(),1000));book.Cancel(2,SubKey('b'));EXPECT_EQ(book.NextDelay(10),290u);
 book.SetEnabled(3,SubKey('c'),false);book.SetEnabled(4,SubKey('d'),false);EXPECT_FALSE(book.NextDelay(1000));
 book.SetEnabled(1,SubKey(),true);auto resumed=book.Take(1,0,false,11);ASSERT_TRUE(resumed.ticket);EXPECT_TRUE(resumed.ticket->full_resources);
}

TEST(RemotePaintSubscriptionCadence, OtherBindingsCannotPostponeUrgentSafetyDeadlineOrTriggerItEarly) {
 Sub book;for(int host=1;host<=2;host++){book.Bind(host,SubKey('a'+host-1),SubContext());ASSERT_TRUE(book.SetCadence(host,SubKey('a'+host-1),100,1000));book.SetEnabled(host,SubKey('a'+host-1),true,0,500);}
 // Host1's first requested frame has not committed. Host2 repeatedly draws.
 for(uint64_t now=500;now<1500;now+=100){
  EXPECT_FALSE(book.RequestDue(1,SubKey(),now));
  auto frame=book.Take(2,0,true,now);ASSERT_TRUE(frame.ticket);SubConsume(book,*frame.ticket);
  ASSERT_TRUE(book.NextDelay(now));EXPECT_LE(*book.NextDelay(now),1500-now);
 }
 ASSERT_TRUE(book.RequestDue(1,SubKey(),1500));EXPECT_FALSE(book.RequestDue(1,SubKey(),1501));
 EXPECT_EQ(book.Inspect(1,SubKey())->last_request_us,1500u);
 book.SetEnabled(2,SubKey('b'),false);EXPECT_EQ(book.NextDelay(1600),900u);
 auto first=book.Take(1,0,false,1600);ASSERT_TRUE(first.ticket);ASSERT_TRUE(book.BeginPublish(*first.ticket));
 EXPECT_EQ(book.Finish(*first.ticket,Sub::Outcome::Retry,2000),Sub::Completion::Released);
 EXPECT_EQ(book.NextDelay(2001),999u);EXPECT_FALSE(book.RequestDue(1,SubKey(),2999));EXPECT_TRUE(book.RequestDue(1,SubKey(),3000));
}

TEST(RemotePaintSubscriptionCredit, SlowLegacyWriterCannotExtendNativeLockDeadline) {
 char directory[]="/tmp/remote-paint-credit-XXXXXX";
 ASSERT_NE(mkdtemp(directory),nullptr);
 const std::string path=std::string(directory)+"/socket";
 const int listener=socket(AF_UNIX,SOCK_STREAM,0);ASSERT_GE(listener,0);
 sockaddr_un address{};address.sun_family=AF_UNIX;
 ASSERT_LT(path.size(),sizeof(address.sun_path));std::ranges::copy(path,std::begin(address.sun_path));
 ASSERT_EQ(bind(listener,reinterpret_cast<const sockaddr*>(&address),sizeof(address)),0);
 ASSERT_EQ(listen(listener,1),0);
 std::promise<bool> accepted;auto connected=accepted.get_future();
 std::atomic<bool> writer_finished=false;
 std::thread server([&] {
   pollfd listening{listener,POLLIN,0};
   if(poll(&listening,1,3000)<=0){accepted.set_value(false);return;}
   const int stream=accept(listener,nullptr,nullptr);
   accepted.set_value(stream>=0);if(stream<0)return;
   const auto until=std::chrono::steady_clock::now()+std::chrono::milliseconds(6250);
   std::array<char,16384> scratch{};
   while(std::chrono::steady_clock::now()<until) {
     pollfd readable{stream,POLLIN,0};
     if(poll(&readable,1,250)>0)(void)recv(stream,scratch.data(),scratch.size(),MSG_DONTWAIT);
     std::this_thread::sleep_for(std::chrono::milliseconds(250));
   }
   close(stream);
 });
 VizSocket transport(path);
 std::thread legacy([&] { (void)transport.Send(std::string(1024*1024,'x'));writer_finished=true; });
 const bool saw_connection=connected.wait_for(std::chrono::seconds(4))==std::future_status::ready&&connected.get();
 Sub book;book.Bind(1,SubKey(),SubContext());book.SetEnabled(1,SubKey(),true);const auto ticket=SubTake(book,1);
 const auto start=std::chrono::steady_clock::now();const auto result=transport.SendWithCredit("unused",ticket);
 const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
 const bool legacy_was_still_writing=!writer_finished.load();
 legacy.join();server.join();close(listener);unlink(path.c_str());rmdir(directory);
 EXPECT_TRUE(saw_connection);EXPECT_FALSE(result);EXPECT_TRUE(legacy_was_still_writing);
 EXPECT_GE(elapsed,4500);EXPECT_LT(elapsed,5750);
}

}
