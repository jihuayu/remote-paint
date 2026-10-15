// Included only by content/renderer/gpu_benchmarking_extension.cc. The callback
// and V8 handles stay on the renderer thread; the worker owns immutable SKPs.
bool GpuBenchmarking::CaptureRemotePaint(gin::Arguments* args) {
  std::string token;
  v8::Local<v8::Function> callback;
  if (!GetArg(args, &token) || !GetArg(args, &callback)) return false;
  const auto expected = base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
      "remote-paint-token");
  if (expected.size() < 32 || token != expected || remote_capture_in_flight_) {
    args->ThrowError();
    return false;
  }
  GpuBenchmarkingContext context(render_frame_.get());
  auto* host = context.layer_tree_host();
  if (!host || !host->root_layer()) return false;
  std::vector<std::pair<int, sk_sp<const SkPicture>>> records;
  for (const auto* layer : *host) {
    auto picture = layer->GetPicture();
    if (!picture) continue;
    if (records.size() >= 256) { args->ThrowError(); return false; }
    records.emplace_back(layer->id(), std::move(picture));
  }
  auto saved_callback = base::MakeRefCounted<CallbackAndContext>(
      args->isolate(), callback, args->isolate()->GetCurrentContext());
  remote_capture_in_flight_ = true;
  const int producer = host->GetId();
  const std::string recording_thread = base::NumberToString(base::PlatformThread::CurrentId().raw());
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce([](int producer, std::string recording_thread,
                        std::vector<std::pair<int, sk_sp<const SkPicture>>> records) {
        base::DictValue result;
        result.Set("producer", producer);
        result.Set("recordingThread", recording_thread);
        result.Set("encodingThread", base::NumberToString(base::PlatformThread::CurrentId().raw()));
        base::ListValue resources;
        size_t total = 0;
        for (auto& [id, picture] : records) {
          auto encoded = remote_paint::SerializePicture(*picture);
          if (!encoded.bytes || (total += encoded.bytes->size()) > 64*1024*1024) {
            result.Set("error", encoded.error.empty() ? "Frame byte budget exceeded" : encoded.error);
            return result;
          }
          base::DictValue resource;
          resource.Set("localId", id);
          resource.Set("skp", base::Base64Encode(base::span(encoded.bytes->bytes(), encoded.bytes->size())));
          resource.Set("width", picture->cullRect().width());
          resource.Set("height", picture->cullRect().height());
          resources.Append(std::move(resource));
        }
        result.Set("resources", std::move(resources));
        return result;
      }, producer, recording_thread, std::move(records)),
      base::BindOnce([](base::WeakPtr<GpuBenchmarking> self,
                        scoped_refptr<CallbackAndContext> callback,
                        base::DictValue result) {
        if (self) self->remote_capture_in_flight_ = false;
        OnMicroBenchmarkCompleted(callback.get(), std::move(result));
      }, weak_factory_.GetWeakPtr(), std::move(saved_callback)));
  return true;
}
