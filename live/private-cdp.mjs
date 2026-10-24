// Trusted backend option only. Never accept a caller-selected listen address.
export function privateCdpArgs(port=null){
 if(port===null)return [];
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw new TypeError('Invalid private CDP port');
 return [`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'];
}
