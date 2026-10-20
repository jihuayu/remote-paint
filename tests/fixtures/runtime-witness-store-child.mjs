import {RuntimeWitnessStore} from '../../service/runtime-witness-store.mjs';
import {runtime,witness} from './runtime-witness-records.mjs';
const store=new RuntimeWitnessStore({directory:process.argv[2]}),receipt=store.persist({...runtime(),witness:witness()});process.send({event:'persisted',receipt});setInterval(()=>{},1000);
