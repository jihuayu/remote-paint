// Browser-side URL handler ownership with real IO threads and Mojo endpoints.
// No HTTP/network-service physical retirement is claimed by these contracts.
#include <atomic>
#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "base/run_loop.h"
#include "base/synchronization/waitable_event.h"
#include "base/task/sequenced_task_runner.h"
#include "base/test/scoped_command_line.h"
#include "base/test/task_environment.h"
#include "base/threading/thread.h"
#include "base/threading/thread_restrictions.h"
#include "base/time/time.h"
#include "components/download/internal/common/resource_downloader.h"
#include "components/download/public/common/download_create_info.h"
#include "components/download/public/common/in_progress_download_manager.h"
#include "components/download/public/common/url_download_handler.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe.h"
#include "mojo/public/cpp/system/message_pipe.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/wrapper_shared_url_loader_factory.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace {
using Handler = download::UrlDownloadHandler;
using Owner = Handler::UniqueUrlDownloadHandlerPtr;
using State = download::UrlDownloadHandlerCleanupState;
using Phase = State::Phase;

struct Latch : base::RefCountedThreadSafe<Latch> {
  Latch() = default;
  bool hold = false;
  base::WaitableEvent entered{base::WaitableEvent::ResetPolicy::MANUAL,
                              base::WaitableEvent::InitialState::NOT_SIGNALED};
  base::WaitableEvent allow{base::WaitableEvent::ResetPolicy::MANUAL,
                            base::WaitableEvent::InitialState::NOT_SIGNALED};
 private:
  friend class base::RefCountedThreadSafe<Latch>;
  ~Latch() = default;
};
class EndpointOwner : public Handler {
 public:
  EndpointOwner(mojo::ScopedMessagePipeHandle owned, scoped_refptr<Latch> latch)
      : endpoint_(std::move(owned)), latch_(latch) {}
  ~EndpointOwner() override {
    latch_->entered.Signal();
    if (latch_->hold) {
      base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
      latch_->allow.Wait();
    }
  }
 private:
  mojo::ScopedMessagePipeHandle endpoint_;
  scoped_refptr<Latch> latch_;
};
// Inject rejection of only the retirement post. The original sequence-safe
// deleter can still post actual destruction to the live IO thread.
class RejectFirstPost : public base::SequencedTaskRunner {
 public:
  explicit RejectFirstPost(scoped_refptr<base::SequencedTaskRunner> io) : io_(io) {}
  bool PostDelayedTask(const base::Location& from, base::OnceClosure task,
                       base::TimeDelta delay) override {
    if (!rejected_.exchange(true)) return false;
    return io_->PostDelayedTask(from, std::move(task), delay);
  }
  bool PostNonNestableDelayedTask(const base::Location& from,
                                  base::OnceClosure task,
                                  base::TimeDelta delay) override {
    return PostDelayedTask(from, std::move(task), delay);
  }
  bool RunsTasksInCurrentSequence() const override {
    return io_->RunsTasksInCurrentSequence();
  }
 private:
  ~RejectFirstPost() override = default;
  scoped_refptr<base::SequencedTaskRunner> io_;
  std::atomic<bool> rejected_{false};
};

class CapturingDelegate : public Handler::Delegate {
 public:
  explicit CapturingDelegate(scoped_refptr<base::SequencedTaskRunner> io) : io_(io) {
    auto secure = base::BindRepeating([](const GURL&) { return true; });
    manager = std::make_unique<download::InProgressDownloadManager>(
        nullptr, base::FilePath(), nullptr, secure,
        base::BindRepeating([](int, const GURL&) { return true; }), base::NullCallback());
  }
  void OnUrlDownloadHandlerCreated(Owner handler) override {
    state = handler->GetRemotePaintRequestCleanupState();
    id = reinterpret_cast<download::UrlDownloadHandlerID>(handler.get());
    static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadHandlerCreated(std::move(handler));
  }
  void OnUrlDownloadStarted(std::unique_ptr<download::DownloadCreateInfo> info,
      std::unique_ptr<download::InputStream> stream,
      download::URLLoaderFactoryProvider::URLLoaderFactoryProviderPtr factory,
      download::UrlDownloadHandlerID downloader,
      download::DownloadUrlParameters::OnStartedCallback callback) override {
    info_state = info->remote_paint_request_cleanup;
    EXPECT_EQ(id, downloader);
    io_->DeleteSoon(FROM_HERE, std::move(stream));
    if (started) std::move(started).Run();
  }
  void OnUrlDownloadStopped(download::UrlDownloadHandlerID downloader) override {
    if (manager) static_cast<Handler::Delegate*>(manager.get())->OnUrlDownloadStopped(downloader);
    if (stopped) std::move(stopped).Run();
  }
  std::unique_ptr<download::InProgressDownloadManager> manager;
  scoped_refptr<State> state;
  scoped_refptr<State> info_state;
  download::UrlDownloadHandlerID id = 0;
  base::OnceClosure started;
  base::OnceClosure stopped;
 private:
  scoped_refptr<base::SequencedTaskRunner> io_;
 public:
  base::WeakPtrFactory<CapturingDelegate> weak{this};
};

class RemotePaintRequestOwnerTest : public testing::Test {
 protected:
  void SetUp() override {
    command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
    base::Thread::Options options; options.message_pump_type = base::MessagePumpType::IO;
    ASSERT_TRUE(io_.StartWithOptions(std::move(options)));
  }
  void TearDown() override { io_.Stop(); tasks_.RunUntilIdle(); }
  void Wait(scoped_refptr<Latch> latch) {
    base::ScopedAllowBaseSyncPrimitivesForTesting allow_wait;
    ASSERT_TRUE(latch->entered.TimedWait(base::Seconds(10)));
  }
  void Barrier() {
    auto latch = base::MakeRefCounted<Latch>();
    io_.task_runner()->PostTask(FROM_HERE, base::BindOnce(
        [](scoped_refptr<Latch> latch) { latch->entered.Signal(); }, latch));
    Wait(latch);
  }
  bool Closed(const mojo::ScopedMessagePipeHandle& peer) {
    return peer->QuerySignalsState().peer_closed();
  }
  Owner FileOwner(mojo::ScopedMessagePipeHandle endpoint,
                  scoped_refptr<Latch> latch) {
    return Owner(new EndpointOwner(std::move(endpoint), latch),
                 base::OnTaskRunnerDeleter(io_.task_runner()));
  }
  void Intercept(CapturingDelegate& delegate,
                 mojo::ScopedMessagePipeHandle* loader_peer,
                 mojo::Remote<network::mojom::URLLoaderClient>* client) {
    mojo::MessagePipe loader, factory;
    *loader_peer = std::move(loader.handle1);
    auto endpoints = network::mojom::URLLoaderClientEndpoints::New();
    endpoints->url_loader = mojo::PendingRemote<network::mojom::URLLoader>(
        std::move(loader.handle0), 0);
    endpoints->url_loader_client = client->BindNewPipeAndPassReceiver();
    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    ASSERT_EQ(MOJO_RESULT_OK, mojo::CreateDataPipe(nullptr, producer, consumer));
    auto head = network::mojom::URLResponseHead::New();
    head->mime_type = "application/octet-stream";
    head->headers = base::MakeRefCounted<net::HttpResponseHeaders>(
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL("https://example.test/download"); request->method = "GET";
    base::RunLoop loop; delegate.started = loop.QuitClosure();
    io_.task_runner()->PostTask(FROM_HERE, base::BindOnce(
      [](base::WeakPtr<CapturingDelegate> delegate,
         std::unique_ptr<network::ResourceRequest> request,
         network::mojom::URLResponseHeadPtr head,
         mojo::ScopedDataPipeConsumerHandle consumer,
         network::mojom::URLLoaderClientEndpointsPtr endpoints,
         mojo::ScopedMessagePipeHandle factory,
         scoped_refptr<base::SingleThreadTaskRunner> ui) {
        auto shared = base::MakeRefCounted<network::WrapperSharedURLLoaderFactory>(
            mojo::PendingRemote<network::mojom::URLLoaderFactory>(std::move(factory), 0));
        download::ResourceDownloader::InterceptNavigationResponse(
            delegate, std::move(request), 1, 1, "", GURL(), GURL(),
            std::vector<GURL>{GURL("https://example.test/download")}, 0,
            std::move(head), std::move(consumer), std::move(endpoints), shared,
            base::BindRepeating([](int, const GURL&) { return true; }), {}, ui, false);
      }, delegate.weak.GetWeakPtr(), std::move(request), std::move(head),
         std::move(consumer), std::move(endpoints), std::move(factory.handle0),
         base::SingleThreadTaskRunner::GetCurrentDefault()));
    loop.Run();
  }
  base::test::TaskEnvironment tasks_{base::test::TaskEnvironment::MainThreadType::IO};
  base::test::ScopedCommandLine command_;
  base::Thread io_{"request-owner-io"};
};

TEST_F(RemotePaintRequestOwnerTest, ActualDestructorAndOriginReplyAreSeparate) {
  mojo::MessagePipe pipe; auto latch = base::MakeRefCounted<Latch>(); latch->hold = true;
  auto owner = FileOwner(std::move(pipe.handle0), latch);
  auto state = owner->GetRemotePaintRequestCleanupState(); ASSERT_TRUE(state);
  base::ScopedClosureRunner release(base::BindOnce(
      [](scoped_refptr<Latch> latch) { latch->allow.Signal(); }, latch));
  download::RetireUrlDownloadHandler(std::move(owner)); Wait(latch);
  EXPECT_EQ(Phase::Queued, state->GetPhase()); EXPECT_FALSE(Closed(pipe.handle1));
  latch->allow.Signal(); Barrier();
  EXPECT_TRUE(Closed(pipe.handle1)); EXPECT_EQ(Phase::OwnerDestroyed, state->GetPhase());
  tasks_.RunUntilIdle(); EXPECT_EQ(Phase::Acknowledged, state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, RejectedRetirementNeverAcknowledgesFallbackDeletion) {
  mojo::MessagePipe pipe; auto latch = base::MakeRefCounted<Latch>();
  auto owner = FileOwner(std::move(pipe.handle0), latch);
  auto state = owner->GetRemotePaintRequestCleanupState();
  owner.get_deleter().task_runner_ = base::MakeRefCounted<RejectFirstPost>(io_.task_runner());
  download::RetireUrlDownloadHandler(std::move(owner)); Barrier(); tasks_.RunUntilIdle();
  EXPECT_TRUE(Closed(pipe.handle1)); EXPECT_EQ(Phase::Failed, state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, DroppedOriginReplyDoesNotAcknowledgeDestroyedOwner) {
  base::Thread origin("short-lived-origin"); ASSERT_TRUE(origin.Start());
  mojo::MessagePipe pipe; auto latch = base::MakeRefCounted<Latch>(); latch->hold = true;
  auto owner = FileOwner(std::move(pipe.handle0), latch); auto state = owner->GetRemotePaintRequestCleanupState();
  base::ScopedClosureRunner release(base::BindOnce(
      [](scoped_refptr<Latch> latch) { latch->allow.Signal(); }, latch));
  origin.task_runner()->PostTask(FROM_HERE, base::BindOnce(
      &download::RetireUrlDownloadHandler, std::move(owner)));
  Wait(latch); origin.Stop(); latch->allow.Signal(); Barrier(); tasks_.RunUntilIdle();
  EXPECT_TRUE(Closed(pipe.handle1)); EXPECT_EQ(Phase::OwnerDestroyed, state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, UntrackedDeletionHasNoRetirementAcknowledgement) {
  mojo::MessagePipe pipe; auto owner = FileOwner(std::move(pipe.handle0), base::MakeRefCounted<Latch>());
  auto state = owner->GetRemotePaintRequestCleanupState(); owner.reset(); Barrier();
  EXPECT_TRUE(Closed(pipe.handle1)); EXPECT_EQ(Phase::Failed, state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, NativePresenceIsSnapshottedAtCreation) {
  mojo::MessagePipe pipe; auto owner = FileOwner(std::move(pipe.handle0), base::MakeRefCounted<Latch>());
  auto state = owner->GetRemotePaintRequestCleanupState();
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  download::RetireUrlDownloadHandler(std::move(owner)); Barrier(); tasks_.RunUntilIdle();
  EXPECT_EQ(Phase::Acknowledged, state->GetPhase()); EXPECT_TRUE(Closed(pipe.handle1));
}

TEST_F(RemotePaintRequestOwnerTest, NonNativeKeepsOriginalDeleter) {
  command_.GetProcessCommandLine()->RemoveSwitch("remote-paint-token");
  mojo::MessagePipe pipe; auto owner = FileOwner(std::move(pipe.handle0), base::MakeRefCounted<Latch>());
  EXPECT_FALSE(owner->GetRemotePaintRequestCleanupState());
  command_.GetProcessCommandLine()->AppendSwitch("remote-paint-token");
  download::RetireUrlDownloadHandler(std::move(owner)); Barrier();
  EXPECT_TRUE(Closed(pipe.handle1));
}

TEST_F(RemotePaintRequestOwnerTest, ActualResourceInfoCarriesSameHandlerWitness) {
  CapturingDelegate delegate(io_.task_runner()); mojo::ScopedMessagePipeHandle peer;
  mojo::Remote<network::mojom::URLLoaderClient> client; Intercept(delegate, &peer, &client);
  ASSERT_TRUE(delegate.state); EXPECT_EQ(delegate.state, delegate.info_state);
  EXPECT_EQ(Phase::Active, delegate.state->GetPhase()); EXPECT_FALSE(Closed(peer));
  static_cast<Handler::Delegate*>(delegate.manager.get())->OnUrlDownloadStopped(delegate.id); Barrier(); tasks_.RunUntilIdle();
  EXPECT_TRUE(Closed(peer)); EXPECT_EQ(Phase::Acknowledged, delegate.state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, ActualResourceNaturalCompletionRetiresThroughManager) {
  CapturingDelegate delegate(io_.task_runner()); mojo::ScopedMessagePipeHandle peer;
  mojo::Remote<network::mojom::URLLoaderClient> client; Intercept(delegate, &peer, &client);
  base::RunLoop stopped; delegate.stopped = stopped.QuitClosure();
  client->OnComplete(network::URLLoaderCompletionStatus(net::OK)); stopped.Run();
  Barrier(); tasks_.RunUntilIdle();
  EXPECT_TRUE(Closed(peer)); EXPECT_EQ(Phase::Acknowledged, delegate.state->GetPhase());
}

TEST_F(RemotePaintRequestOwnerTest, ActualManagerDestructionRetiresActiveResource) {
  CapturingDelegate delegate(io_.task_runner()); mojo::ScopedMessagePipeHandle peer;
  mojo::Remote<network::mojom::URLLoaderClient> client; Intercept(delegate, &peer, &client);
  auto state = delegate.state; delegate.manager.reset();
  EXPECT_EQ(Phase::Queued, state->GetPhase()); Barrier(); tasks_.RunUntilIdle();
  EXPECT_TRUE(Closed(peer)); EXPECT_EQ(Phase::Acknowledged, state->GetPhase());
}
}  // namespace
