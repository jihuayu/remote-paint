import {spawn} from 'node:child_process';
import {mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const target=process.env.CARGO_TARGET_DIR??fileURLToPath(new URL('../../../work/broker-target',import.meta.url));
const manifest=fileURLToPath(new URL('./broker/Cargo.toml',import.meta.url));
await new Promise((resolve,reject)=>{const child=spawn('cargo',['build','--release','--locked','--manifest-path',manifest],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:target}});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Broker build exited ${code}`)));});
await mkdir(new URL('./bin/',import.meta.url),{recursive:true});await copyFile(`${target}/release/remote-paint-broker`,new URL('./bin/remote-paint-broker',import.meta.url));
