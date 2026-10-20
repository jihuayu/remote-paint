import {RuntimeWitnessStore} from '../../service/runtime-witness-store.mjs';
import {runtime,witness} from './runtime-witness-records.mjs';
if(process.argv[3]==='restricted-umask')process.umask(0o277);
const store=new RuntimeWitnessStore({directory:process.argv[2]});try{const receipt=store.persist({...runtime(),witness:witness()});process.send({event:'persisted',receipt});}catch(e){process.send({event:'persist-failed',code:e.code});}setInterval(()=>{},1000);
