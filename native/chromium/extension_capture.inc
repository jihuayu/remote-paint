// Included by the renderer extension. Context/V8 handles remain on this thread.
bool GpuBenchmarking::CaptureRemotePaint(gin::Arguments* args) {
  std::string token, capture_id;
  v8::Local<v8::Function> callback;
  if (!GetArg(args,&token) || !GetArg(args,&capture_id) || !GetArg(args,&callback)) return false;
  bool force_resources = false;
  if (args->Length() > 3 && !GetArg(args,&force_resources)) return false;
  const auto expected=base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("remote-paint-token");
  if(expected.size()<32 || token!=expected || capture_id.empty() || capture_id.size()>128 || remote_capture_in_flight_){args->ThrowError();return false;}
  GpuBenchmarkingContext context(render_frame_.get());auto* host=context.layer_tree_host();
  if(!host || !host->root_layer())return false;
  auto saved=base::MakeRefCounted<CallbackAndContext>(args->isolate(),callback,args->isolate()->GetCurrentContext());
  auto reply=base::BindPostTaskToCurrentDefault(base::BindOnce(
    [](base::WeakPtr<GpuBenchmarking> self,scoped_refptr<CallbackAndContext> callback,base::DictValue result){
      if(self)self->remote_capture_in_flight_=false;
      OnMicroBenchmarkCompleted(callback.get(),std::move(result));
    },weak_factory_.GetWeakPtr(),std::move(saved)));
  if(!remote_paint::RequestCapture(host->GetId(),std::move(capture_id),std::move(reply),force_resources))return false;
  remote_capture_in_flight_=true;
  host->SetNeedsCommitWithForcedRedraw();
  return true;
}
