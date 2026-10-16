#ifndef COMPONENTS_REMOTE_PAINT_SOCKET_TRANSPORT_H_
#define COMPONENTS_REMOTE_PAINT_SOCKET_TRANSPORT_H_
#include <algorithm>
#include <bit>
#include <cstring>
#include <cstdint>
#include <string>
#include <string_view>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <arpa/inet.h>
#include "base/containers/span.h"
#include "base/synchronization/lock.h"
namespace remote_paint {
class VizSocket {
 public:
  explicit VizSocket(std::string path) : path_(std::move(path)) {}

  bool Send(std::string_view bytes) {
    base::AutoLock guard(lock_);
    if (fd_ < 0 && !Connect()) return false;
    uint32_t length = htonl(bytes.size());
    std::string packet(reinterpret_cast<const char*>(&length), sizeof(length));
    packet.append(bytes);
    if (!SendAll(base::span(packet))) {
      Close();
      return false;
    }
    return true;
  }

 private:
  bool Connect() {
    fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd_ < 0) return false;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (path_.size() >= sizeof(address.sun_path)) {
      Close();
      return false;
    }
    // SAFETY: The path length is checked against the destination above.
    std::ranges::copy(path_, std::begin(address.sun_path));
    timeval timeout{1, 0};
    setsockopt(fd_, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#if defined(SO_NOSIGPIPE)
    int no_sigpipe = 1;
    setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
#endif
    if (connect(fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      Close();
      return false;
    }
    return true;
  }

  bool SendAll(base::span<const char> data) {
    size_t sent = 0;
    while (sent < data.size()) {
      int flags = 0;
#if defined(MSG_NOSIGNAL)
      flags = MSG_NOSIGNAL;
#endif
      const auto remaining = data.subspan(sent);
      const auto written = send(fd_, remaining.data(), remaining.size(), flags);
      if (written <= 0) return false;
      sent += static_cast<size_t>(written);
    }
    return true;
  }

  void Close() {
    if (fd_ >= 0) {
      close(fd_);
      fd_ = -1;
    }
  }

  base::Lock lock_;
  std::string path_;
  int fd_ = -1;
};

class BinaryWriter {
 public:
  void Bytes(std::string_view value){bytes.append(value);}
  void U8(uint8_t value){bytes.push_back(static_cast<char>(value));}
  void U32(uint32_t value){bytes.push_back(static_cast<char>(value>>24));bytes.push_back(static_cast<char>(value>>16));bytes.push_back(static_cast<char>(value>>8));bytes.push_back(static_cast<char>(value));}
  void I32(int32_t value){U32(static_cast<uint32_t>(value));}
  void F64(double value){const auto bits=std::bit_cast<uint64_t>(value);for(int shift=56;shift>=0;shift-=8)bytes.push_back(static_cast<char>(bits>>shift));}
  void String(std::string_view value){U32(value.size());bytes.append(value);}
  void SetU32(size_t offset,uint32_t value){bytes[offset]=static_cast<char>(value>>24);bytes[offset+1]=static_cast<char>(value>>16);bytes[offset+2]=static_cast<char>(value>>8);bytes[offset+3]=static_cast<char>(value);}
  size_t size() const{return bytes.size();}
  std::string bytes;
};
}
#endif
