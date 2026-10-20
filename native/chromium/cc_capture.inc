// Runs on the owning compositor thread after GenerateCompositorFrame. Only
// immutable pictures and scalar metadata leave this thread. No tile/GPU handle
// is used as a permanent content identity.
if (auto request = remote_paint::TakeCapture(id(),active_tree()->source_frame_number(),
    !compositor_frame.render_pass_list.empty()&&!compositor_frame.render_pass_list.back()->damage_rect.IsEmpty())) {
  // Cache immutable source generations and encoding keys only. The cache
  // cannot extend any RasterSource/display-list/picture/image/font lifetime.
  if(!remote_paint_recording_cache_)
    remote_paint_recording_cache_=remote_paint::GetRecordingIndexPool().CreateCache();
  auto* recording_index=static_cast<remote_paint::RecordingKeyCache*>(remote_paint_recording_cache_.get());
  if(recording_index)recording_index->BeginCapture();
  remote_paint::Snapshot snapshot;
  snapshot.recording_index_enabled=recording_index!=nullptr;
  if(remote_paint::GetRecordingIndexPool().stats().limit==0)snapshot.error="Invalid REMOTE_PAINT_RECORDING_INDEX_BYTES";
  if(request->subscription) {
    const auto& target=request->subscription->context;
    const auto viewport=active_tree()->GetDeviceViewport().size();
    const double scale=active_tree()->device_scale_factor();
    if(viewport.width()!=std::round(target.css_width*scale)||viewport.height()!=std::round(target.css_height*scale)) {
      snapshot.error="Native subscription viewport changed before capture";
      snapshot.error_code="NATIVE_SUBSCRIPTION_TARGET_CHANGED";
    }
  }
  snapshot.capture_id = request->capture_id;
  snapshot.producer = base::NumberToString(base::GetCurrentProcId()) + ":" + base::NumberToString(id());
  snapshot.recording_thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  snapshot.frame_token = compositor_frame.metadata.frame_token;
  snapshot.source_frame = active_tree()->source_frame_number();
  compositor_frame.metadata.remote_paint_capture_id = remote_paint::RememberCaptureFrameMarker(
      id(), request->capture_id, compositor_frame.metadata.frame_token);
  const auto recording_started = base::TimeTicks::Now();
  for (auto* layer : *active_tree()) {
    if(!snapshot.error.empty())break;
    if (layer->GetLayerType() == cc::mojom::LayerType::kTexture) {
      const auto* texture = static_cast<cc::TextureLayerImpl*>(layer);
      if (texture->transferable_resource().resource_source ==
          viz::TransferableResource::ResourceSource::kDrawingBuffer) {
        snapshot.webgl_layers.push_back(layer->stable_id_for_shared_quad_state());
      }
      const auto& resource=texture->transferable_resource();
      if (resource.resource_source==viz::TransferableResource::ResourceSource::kCanvas &&
          !resource.is_empty()&&!layer->bounds().IsEmpty()) {
        if(snapshot.records.size()>=256){snapshot.error="Layer recording budget exceeded";break;}
        const auto size=resource.GetSize();size_t pixel_bytes=0;
        if(!remote_paint::CanvasPixelSize(size.width(),size.height(),&pixel_bytes)||!resource.GetFormat().is_single_plane()){
          snapshot.error="Canvas image exceeds decoded budget or format";break;
        }
        auto pixels=remote_paint::AllocateCanvasPixels(remote_paint::GetCanvasPixelPool(),pixel_bytes,&snapshot.error);
        if(!pixels){if(snapshot.error==remote_paint::kCanvasPixelPressure)snapshot.error_code="RESOURCE_BUDGET_PRESSURE";break;}
        auto color_space=resource.GetColorSpace().ToSkColorSpace();if(!color_space)color_space=SkColorSpace::MakeSRGB();
        const auto info=SkImageInfo::Make(size.width(),size.height(),kRGBA_8888_SkColorType,kPremul_SkAlphaType,color_space);
        bool flip_y=false;
        if(resource.GetIsSoftware()){
          auto mapping=resource.shared_image()->Map();if(!mapping){snapshot.error="Canvas software mapping failed";break;}
          const auto source_info=SkImageInfo::Make(size.width(),size.height(),viz::ToClosestSkColorType(resource.GetFormat()),resource.GetAlphaType(),color_space);
          const auto source=mapping->GetSkPixmapForPlane(0,source_info);
          if(!remote_paint::CopyCanvasPixmap(source,info,pixels.get(),&snapshot.error))break;
          flip_y=resource.GetOrigin()==kBottomLeft_GrSurfaceOrigin;snapshot.canvas_mapped_copies++;
        }else{
          auto* context=layer_tree_frame_sink_?layer_tree_frame_sink_->context_provider():nullptr;
          const auto usage=resource.shared_image()->usage();
          if(!context||context->IsLost()||(!usage.Has(gpu::SHARED_IMAGE_USAGE_RASTER_READ)&&!usage.Has(gpu::SHARED_IMAGE_USAGE_RASTER_COPY_SOURCE))){snapshot.error="Canvas GPU raster readback unavailable";break;}
          auto* raster=context->RasterInterface();auto access=resource.shared_image()->BeginRasterAccess(raster,resource.sync_token(),true);
          const bool copied=raster->ReadbackImagePixels(resource.mailbox(),info,static_cast<GLuint>(info.minRowBytes()),0,0,0,pixels->writable_data());
          // Synchronous readback completes the resource read before access
          // ends or another compositor frame can reuse the source resource.
          (void)gpu::RasterScopedAccess::EndAccess(std::move(access));
          if(!copied){snapshot.error="Canvas GPU pixel readback failed";break;}snapshot.canvas_gpu_readbacks++;
        }
        auto image=SkImages::RasterFromData(info,std::move(pixels),info.minRowBytes());
        SkColor4f background=texture->blend_background_color()?texture->background_color():SkColors::kTransparent;
        if(texture->force_texture_to_opaque())background=SkColors::kBlack;
        const auto uv0=texture->uv_top_left(),uv1=texture->uv_bottom_right();
        auto picture=remote_paint::CanvasPicture(std::move(image),layer->bounds().width(),layer->bounds().height(),{uv0.x(),uv0.y(),uv1.x(),uv1.y()},flip_y,texture->GetFilterQuality()==cc::PaintFlags::FilterQuality::kNone,background,&snapshot.error);
        if(!picture)break;snapshot.canvas_copies++;
        // One origin-zero full-layer tile composes with tiled PictureLayers
        // without repeating a complete Canvas image for every256px tile.
        snapshot.records.push_back({layer->stable_id_for_shared_quad_state(),1.f,std::move(picture),remote_paint::NewRecordingKey(),{},remote_paint::IsTiledCaptureEnabled(),0,0,true});
      }
    }
    if (layer->GetLayerType() != cc::mojom::LayerType::kPicture) continue;
    auto* picture_layer = static_cast<PictureLayerImpl*>(layer);
    auto* source = picture_layer->GetRasterSource();
    if (!source || !source->HasRecordings() || layer->bounds().IsEmpty()) continue;
    if (snapshot.records.size() >= 256 || source->size().width() > 8192 || source->size().height() > 8192) {
      snapshot.error = "Layer recording budget exceeded"; break;
    }
    const int local_id = layer->stable_id_for_shared_quad_state();
    const auto source_id=source->remote_paint_source_id();
    if (remote_paint::IsTiledCaptureEnabled()) {
      const auto damage=remote_paint::TakeLayerDamage(id(),local_id);
      for(int y=0;y<source->size().height();y+=256) {
        for(int x=0;x<source->size().width();x+=256) {
          if(snapshot.records.size()>=256){snapshot.error="Tile recording budget exceeded";break;}
          const gfx::Rect tile(x,y,std::min(256,source->size().width()-x),std::min(256,source->size().height()-y));
          const bool damaged=damage&&tile.Intersects(gfx::Rect((*damage)[0],(*damage)[1],(*damage)[2]-(*damage)[0],(*damage)[3]-(*damage)[1]));
          auto prior=recording_index?recording_index->Reusable(local_id,x,y,source_id,source->size().width(),source->size().height(),damage.has_value(),damaged):std::nullopt;
          uint64_t recording_key=prior.value_or(0);
          auto encoded=prior?remote_paint::LookupCachedEncoding(request->owner,*prior):nullptr;
          sk_sp<const SkPicture> picture;
          if(encoded)snapshot.recording_cache_hits++;
          else {
            if(prior)snapshot.recording_encoding_misses++;
            SkPictureRecorder recorder;
            auto* canvas=recorder.beginRecording(tile.width(),tile.height());
            RasterSource::PlaybackSettings settings;settings.use_lcd_text=false;
            auto offsets=static_cast<PictureLayerTilingClient*>(picture_layer)->GetRasterInducingScrollOffsets();settings.raster_inducing_scroll_offsets=&offsets;
            source->PlaybackToCanvas(canvas,source->size(),tile,tile,gfx::AxisTransform2d(),settings);
            picture=recorder.finishRecordingAsPicture();recording_key=remote_paint::NewRecordingKey();snapshot.recording_cache_misses++;
          }
          if(recording_index)recording_index->Put(local_id,x,y,source_id,source->size().width(),source->size().height(),recording_key);
          snapshot.records.push_back({local_id,picture_layer->GetMaximumContentsScaleForUseInAppendQuads(),std::move(picture),recording_key,std::move(encoded),true,x,y,false,tile.width(),tile.height()});
        }
        if(!snapshot.error.empty())break;
      }
      if(!snapshot.error.empty())break;
      continue;
    }
    sk_sp<const SkPicture> picture;
    auto prior=recording_index?recording_index->Reusable(local_id,-1,-1,source_id,source->size().width(),source->size().height(),false,false):std::nullopt;
    uint64_t recording_key=prior.value_or(0);
    auto encoded=prior?remote_paint::LookupCachedEncoding(request->owner,*prior):nullptr;
    if(encoded)snapshot.recording_cache_hits++;
    else {
      if(prior)snapshot.recording_encoding_misses++;
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
      snapshot.recording_cache_misses++;
    }
    if(recording_index)recording_index->Put(local_id,-1,-1,source_id,source->size().width(),source->size().height(),recording_key);
    snapshot.records.push_back({local_id,
      picture_layer->GetMaximumContentsScaleForUseInAppendQuads(), std::move(picture),
      recording_key, std::move(encoded),false,0,0,false,source->size().width(),source->size().height()});
  }
  if(recording_index){
    recording_index->EndCapture(snapshot.error.empty());
    snapshot.recording_index_entries=static_cast<int>(recording_index->size());
  }
  snapshot.recording_ms = (base::TimeTicks::Now() - recording_started).InMillisecondsF();
  remote_paint::EncodeAndReply(std::move(snapshot), std::move(request));
} else {
  // A generated frame can be skipped before the browser embeds its surface.
  // Preserve the requested token so Viz can report supersession explicitly;
  // it must never combine a later scene with that frame's earlier SKPs.
  compositor_frame.metadata.remote_paint_capture_id = remote_paint::LastCaptureFrameMarker(id());
}
