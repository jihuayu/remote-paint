// Runs on the owning compositor thread after GenerateCompositorFrame. Only
// immutable pictures and scalar metadata leave this thread. No tile/GPU handle
// is used as a permanent content identity.
if (auto request = remote_paint::TakeCapture(id())) {
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
    SkPictureRecorder recorder;
    auto* canvas = recorder.beginRecording(source->size().width(), source->size().height());
    RasterSource::PlaybackSettings settings;
    settings.use_lcd_text = false;
    auto offsets = static_cast<PictureLayerTilingClient*>(picture_layer)->GetRasterInducingScrollOffsets();
    settings.raster_inducing_scroll_offsets = &offsets;
    const gfx::Rect whole(source->size());
    source->PlaybackToCanvas(canvas, source->size(), whole, whole, gfx::AxisTransform2d(), settings);
    snapshot.records.push_back({layer->stable_id_for_shared_quad_state(),
      picture_layer->GetMaximumContentsScaleForUseInAppendQuads(), recorder.finishRecordingAsPicture()});
  }
  snapshot.recording_ms = (base::TimeTicks::Now() - recording_started).InMillisecondsF();
  remote_paint::EncodeAndReply(std::move(snapshot), std::move(request));
}
