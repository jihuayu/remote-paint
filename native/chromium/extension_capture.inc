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

namespace {
bool RemotePaintInteger(gin::Arguments* args,uint64_t* value) {
  double number;
  if(!GetArg(args,&number)||!std::isfinite(number)||number<0||
     number>remote_paint::SubscriptionState::kMaxSafeInteger||std::floor(number)!=number)return false;
  *value=static_cast<uint64_t>(number);return true;
}
base::DictValue RemotePaintSubscriptionResult(
    const std::optional<remote_paint::SubscriptionState::Snapshot>& snapshot) {
  base::DictValue out;out.Set("ok",snapshot.has_value());
  if(!snapshot)return out;
  const auto& s=*snapshot;
  out.Set("id",std::string(s.key.view()));out.Set("generation",static_cast<double>(s.generation));
  out.Set("ordinalBase",static_cast<double>(s.ordinal_base));
  out.Set("ordinalLimit",static_cast<double>(s.ordinal_limit));
  // This includes jobs encoding/inIPC, not just the last mapped scene.
  out.Set("lastStarted",static_cast<double>(s.last_started));
  out.Set("inputSeq",static_cast<double>(s.context.input_seq));
  out.Set("pageEpoch",static_cast<double>(s.context.page_epoch));
  out.Set("viewportVersion",static_cast<double>(s.context.viewport_version));
  out.Set("cssWidth",static_cast<int>(s.context.css_width));out.Set("cssHeight",static_cast<int>(s.context.css_height));
  out.Set("minimumSourceFrame",s.minimum_source_frame);out.Set("host",s.host);
  out.Set("enabled",s.enabled);out.Set("retiring",s.retiring);out.Set("exhausted",s.exhausted);
  out.Set("inflight",s.phase!=remote_paint::SubscriptionState::Phase::Idle);
  out.Set("awaitingCredit",s.phase==remote_paint::SubscriptionState::Phase::AwaitingCredit);
  out.Set("intervalMicros",static_cast<double>(s.interval_us));out.Set("heartbeatMicros",static_cast<double>(s.heartbeat_us));
  out.Set("lastStartedMicros",static_cast<double>(s.last_started_us));out.Set("pendingDamage",s.pending_damage);
  return out;
}
}  // namespace

void GpuBenchmarking::ControlRemotePaint(gin::Arguments* args) {
  std::string token,operation,scope;
  if(!GetArg(args,&token)||!GetArg(args,&operation)||!GetArg(args,&scope)) { args->ThrowError();return; }
  const auto expected=base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("remote-paint-token");
  auto key=remote_paint::SubscriptionState::Key::Parse(scope);
  if(expected.size()<32||token!=expected||!key||!render_frame_||!render_frame_->IsMainFrame()) {
    args->ThrowError();return;
  }
  auto* frame=render_frame_->GetWebFrame();
  if(!frame) { args->ThrowError();return; }
  const int world=frame->GetScriptContextWorldId(args->isolate()->GetCurrentContext());
  if(world<=0) { args->ThrowError();return; }
  const auto document=frame->GetDocument();
  if(document.IsNull()) { args->ThrowError();return; }
  // RenderFrameImpl and isolated-world IDs can survive a new document. Read
  // Blink's actual document identity in this command's renderer context.
  const std::string document_token=document.Token().ToString();
  GpuBenchmarkingContext context(render_frame_.get());auto* host=context.layer_tree_host();
  base::DictValue out;out.Set("ok",false);
  const bool document_bind=operation=="bindDocument";
  std::string expected_document;
  if(document_bind&&(!GetArg(args,&expected_document)||expected_document.empty()||expected_document.size()>64)) {
    args->ThrowError();return;
  }
  if(operation=="describe") {
    out.Set("ok",true);out.Set("subscriptionVersion",2);
    out.Set("cadenceVersion",1);
    out.Set("documentToken",document_token);
    out.Set("ready",host&&host->root_layer());
  } else if(operation=="scheduler") {
    out=remote_paint::CaptureSchedulerStats();
  } else if(document_bind&&expected_document!=document_token) {
    // No scope/generation/ordinal is allocated on a stale-document request.
    out.Set("code","NATIVE_DOCUMENT_CHANGED");out.Set("documentToken",document_token);
  } else if(host&&host->root_layer()) {
    const int id=host->GetId();
    if(operation=="bind"||document_bind) {
      uint64_t epoch,viewport,input,width,height,minimum;
      if(!RemotePaintInteger(args,&epoch)||!RemotePaintInteger(args,&viewport)||
         !RemotePaintInteger(args,&input)||!RemotePaintInteger(args,&width)||
         !RemotePaintInteger(args,&height)||!RemotePaintInteger(args,&minimum)||width>4096||height>4096) {
        args->ThrowError();return;
      }
      auto wake=base::BindPostTaskToCurrentDefault(base::BindRepeating(
        [](base::WeakPtr<RenderFrameImpl> frame,int expected_host,remote_paint::SubscriptionState::Key key) {
          if(!frame)return;
          GpuBenchmarkingContext context(frame.get());auto* current=context.layer_tree_host();
          const auto binding=remote_paint::InspectCaptureSubscription(expected_host,key);
          if(current&&current->GetId()==expected_host&&current->root_layer()&&binding&&
             binding->enabled&&!binding->retiring)current->SetNeedsCommitWithForcedRedraw();
        },render_frame_,id,*key));
      const auto bound=remote_paint::BindCaptureSubscription(id,reinterpret_cast<uintptr_t>(render_frame_.get()),world,*key,
        {epoch,viewport,input,static_cast<uint32_t>(width),static_cast<uint32_t>(height)},minimum,host->SourceFrameNumber(),std::move(wake));
      out=RemotePaintSubscriptionResult(bound.snapshot);
      if(document_bind&&bound.status==remote_paint::SubscriptionState::BindStatus::Bound){
        const bool configured=remote_paint::SetCaptureCadence(id,*key,16667,1'000'000);
        out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));
        if(!configured){out.Set("ok",false);out.Set("code","NATIVE_SUBSCRIPTION_CHANGED");}
      }
      out.Set("bindStatus",static_cast<int>(bound.status));
      if(document_bind)out.Set("documentToken",document_token);
    } else if(operation=="inspect") {
      out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));
    } else if(operation=="enable") {
      bool enabled;if(!GetArg(args,&enabled)) { args->ThrowError();return; }
      const bool ok=remote_paint::EnableCaptureSubscription(id,*key,enabled,host->SourceFrameNumber());
      out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));out.Set("ok",ok);
    } else if(operation=="update") {
      uint64_t input;bool full,request_frame;
      if(!RemotePaintInteger(args,&input)||!GetArg(args,&full)||!GetArg(args,&request_frame)) { args->ThrowError();return; }
      const bool ok=remote_paint::UpdateCaptureSubscription(id,*key,input,full,request_frame,host->SourceFrameNumber());
      out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));out.Set("ok",ok);
    } else if(operation=="cadence") {
      double interval_ms,heartbeat_ms;
      if(!GetArg(args,&interval_ms)||!GetArg(args,&heartbeat_ms)||!std::isfinite(interval_ms)||!std::isfinite(heartbeat_ms)||
         interval_ms<0||heartbeat_ms<=0||heartbeat_ms>1000||interval_ms>heartbeat_ms){args->ThrowError();return;}
      const bool ok=remote_paint::SetCaptureCadence(id,*key,static_cast<uint64_t>(std::ceil(interval_ms*1000)),
          static_cast<uint64_t>(std::ceil(heartbeat_ms*1000)));
      out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));out.Set("ok",ok);
    } else if(operation=="cancel") {
      const bool ok=remote_paint::CancelCaptureSubscription(id,*key);
      out=RemotePaintSubscriptionResult(remote_paint::InspectCaptureSubscription(id,*key));out.Set("ok",ok);
    } else { args->ThrowError();return; }
  } else if(document_bind) {
    out.Set("code","NATIVE_NOT_READY");out.Set("documentToken",document_token);
  }
  args->Return(content::V8ValueConverter::Create()->ToV8Value(
    base::Value(std::move(out)),args->isolate()->GetCurrentContext()));
}
