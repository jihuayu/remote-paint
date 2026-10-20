#ifndef COMPONENTS_REMOTE_PAINT_SUBSCRIPTION_CREDIT_H_
#define COMPONENTS_REMOTE_PAINT_SUBSCRIPTION_CREDIT_H_
#include <array>
#include <optional>
#include <string_view>
#include "components/remote_paint/subscription_state.h"

namespace remote_paint {
// Fixed-size, exact-job receipt. A successful socket write is never credit.
// Broker emits this only after mapping/publication or definitive rejection.
inline constexpr size_t kSubscriptionCreditBytes = 56;
inline std::array<char,kSubscriptionCreditBytes> MakeSubscriptionCredit(
    const SubscriptionState::Ticket& ticket,SubscriptionState::Outcome outcome) {
  std::array<char,kSubscriptionCreditBytes> bytes{};
  bytes[0]='R';bytes[1]='P';bytes[2]='C';bytes[3]='3';bytes[4]=1;
  bytes[5]=outcome==SubscriptionState::Outcome::Consumed?1:
    outcome==SubscriptionState::Outcome::Retry?2:3;
  std::copy(ticket.key.bytes.begin(),ticket.key.bytes.end(),bytes.begin()+8);
  for(size_t i=0;i<8;++i) {
    bytes[40+i]=static_cast<char>(ticket.ordinal>>(56-8*i));
    bytes[48+i]=static_cast<char>(ticket.generation>>(56-8*i));
  }
  return bytes;
}
inline std::optional<SubscriptionState::Outcome> ParseSubscriptionCredit(
    std::string_view bytes,const SubscriptionState::Ticket& ticket) {
  if(bytes.size()!=kSubscriptionCreditBytes||bytes.substr(0,5)!=std::string_view("RPC3\1",5)||
     bytes[6]!=0||bytes[7]!=0)return std::nullopt;
  const unsigned char kind=static_cast<unsigned char>(bytes[5]);
  if(kind<1||kind>3)return std::nullopt;
  const auto outcome=kind==1?SubscriptionState::Outcome::Consumed:
    kind==2?SubscriptionState::Outcome::Retry:SubscriptionState::Outcome::Pause;
  const auto expected=MakeSubscriptionCredit(ticket,outcome);
  if(bytes!=std::string_view(expected.data(),expected.size()))return std::nullopt;
  return outcome;
}
}  // namespace remote_paint
#endif
