#include <tuple>

// Runs on the owning compositor thread after GenerateCompositorFrame. Only
// immutable pictures and scalar metadata leave this thread. No tile/GPU handle
// is used as a permanent content identity.
if (auto request = remote_paint::TakeCapture(id())) {
  using RemotePaintDisplayList = const void*;
  using RemotePaintCacheEntry = std::tuple<
      scoped_refptr<const RasterSource>, RemotePaintDisplayList,
      sk_sp<const SkPicture>, uint64_t,
      std::shared_ptr<const remote_paint::EncodedPicture>>;
  using RemotePaintLayerCacheV2 = std::map<int, std::map<int, RemotePaintCacheEntry>>;
  static base::NoDestructor<RemotePaintLayerCacheV2> layer_caches;
  auto& layer_cache = (*layer_caches)[id()];
  if (layer_cache.size() > 512) layer_cache.clear();
  remote_paint::Snapshot snapshot;
  snapshot.capture_id = request->capture_id;
  snapshot.producer = base::NumberToString(base::GetCurrentProcId()) + ":" + base::NumberToString(id());
  snapshot.recording_thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  snapshot.frame_token = compositor_frame.metadata.frame_token;
  snapshot.source_frame = active_tree()->source_frame_number();
  compositor_frame.metadata.remote_paint_capture_id = request->capture_id;
  const auto recording_started = base::TimeTicks::Now();
  for (auto* layer : *active_tree()) {
    if (layer->GetLayerType() != cc::mojom::LayerType::kPicture) continue;
    auto* picture_layer = static_cast<PictureLayerImpl*>(layer);
    auto* source = picture_layer->GetRasterSource();
    if (!source || !source->HasRecordings() || layer->bounds().IsEmpty()) continue;
    if (snapshot.records.size() >= 256 || source->size().width() > 8192 || source->size().height() > 8192) {
      snapshot.error = "Layer recording budget exceeded"; break;
    }
    const int local_id = layer->stable_id_for_shared_quad_state();
    scoped_refptr<const RasterSource> source_ref = source;
    if (remote_paint::IsTiledCaptureEnabled()) {
      struct TileRecord {
        sk_sp<const SkPicture> picture;
        uint64_t key = 0;
      };
      struct TiledLayer {
        scoped_refptr<const RasterSource> source;
        RemotePaintDisplayList display_list = nullptr;
        std::map<std::pair<int,int>,TileRecord> tiles;
      };
      static base::NoDestructor<std::map<int,std::map<int,TiledLayer>>> tiled_caches;
      auto& host_tiles=(*tiled_caches)[id()];
      if(host_tiles.size()>512)host_tiles.clear();
      auto& cache=host_tiles[local_id];
      const auto damage=remote_paint::TakeLayerDamage(id(),local_id);
      const bool unchanged=cache.source.get()==source_ref.get()&&cache.display_list==source->GetDisplayItemList().get();
      const bool size_changed=!cache.source||cache.source->size()!=source->size();
      std::map<std::pair<int,int>,TileRecord> next;
      for(int y=0;y<source->size().height();y+=256) {
        for(int x=0;x<source->size().width();x+=256) {
          if(snapshot.records.size()>=256){snapshot.error="Tile recording budget exceeded";break;}
          const gfx::Rect tile(x,y,std::min(256,source->size().width()-x),std::min(256,source->size().height()-y));
          const auto tile_id=std::make_pair(x,y);
          auto found=cache.tiles.find(tile_id);
          const bool damaged=damage&&tile.Intersects(gfx::Rect((*damage)[0],(*damage)[1],(*damage)[2]-(*damage)[0],(*damage)[3]-(*damage)[1]));
          TileRecord record;
          if(found!=cache.tiles.end()&&!size_changed&&(!damaged&&(unchanged||damage.has_value()))) {
            record=found->second;snapshot.recording_cache_hits++;
          } else {
            SkPictureRecorder recorder;
            auto* canvas=recorder.beginRecording(tile.width(),tile.height());
            RasterSource::PlaybackSettings settings;settings.use_lcd_text=false;
            auto offsets=static_cast<PictureLayerTilingClient*>(picture_layer)->GetRasterInducingScrollOffsets();settings.raster_inducing_scroll_offsets=&offsets;
            source->PlaybackToCanvas(canvas,source->size(),tile,tile,gfx::AxisTransform2d(),settings);
            record={recorder.finishRecordingAsPicture(),remote_paint::NewRecordingKey()};snapshot.recording_cache_misses++;
          }
          auto encoded=remote_paint::LookupCachedEncoding(id(),record.key);
          snapshot.records.push_back({local_id,picture_layer->GetMaximumContentsScaleForUseInAppendQuads(),record.picture,record.key,std::move(encoded),true,x,y});
          next.emplace(tile_id,std::move(record));
        }
        if(!snapshot.error.empty())break;
      }
      cache={source_ref,static_cast<RemotePaintDisplayList>(source->GetDisplayItemList().get()),std::move(next)};
      if(!snapshot.error.empty())break;
      continue;
    }
    auto cached = layer_cache.find(local_id);
    sk_sp<const SkPicture> picture;
    std::shared_ptr<const remote_paint::EncodedPicture> encoded;
    uint64_t recording_key = 0;
    const auto display_list = static_cast<RemotePaintDisplayList>(
        source->GetDisplayItemList().get());
    if (cached != layer_cache.end() &&
        std::get<0>(cached->second).get() == source_ref.get() &&
        std::get<1>(cached->second) == display_list) {
      picture = std::get<2>(cached->second);
      recording_key = std::get<3>(cached->second);
      encoded = remote_paint::LookupCachedEncoding(id(), recording_key);
      snapshot.recording_cache_hits++;
    } else {
      SkPictureRecorder recorder;
      auto* canvas = recorder.beginRecording(source->size().width(), source->size().height());
      RasterSource::PlaybackSettings settings;
      settings.use_lcd_text = false;
      auto offsets = static_cast<PictureLayerTilingClient*>(picture_layer)->GetRasterInducingScrollOffsets();
      settings.raster_inducing_scroll_offsets = &offsets;
      const gfx::Rect whole(source->size());
      source->PlaybackToCanvas(canvas, source->size(), whole, whole, gfx::AxisTransform2d(), settings);
      picture = recorder.finishRecordingAsPicture();
      recording_key = remote_paint::NewRecordingKey();
      layer_cache[local_id] = {source_ref, display_list, picture, recording_key, encoded};
      snapshot.recording_cache_misses++;
    }
    snapshot.records.push_back({local_id,
      picture_layer->GetMaximumContentsScaleForUseInAppendQuads(), std::move(picture),
      recording_key, std::move(encoded)});
  }
  snapshot.recording_ms = (base::TimeTicks::Now() - recording_started).InMillisecondsF();
  remote_paint::EncodeAndReply(std::move(snapshot), std::move(request));
}
