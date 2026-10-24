/** Disposable admission probe. A test-only HTTP tripwire prevents binding any port. */
import http from 'node:http';
const version=process.env.RUNTIME_TEST_VERSION;
if(version)Object.defineProperty(process.versions,'node',{value:version,configurable:true});
http.Server.prototype.listen=function():never{throw Object.assign(new Error('HTTP binding was reached'),{code:'RUNTIME_TEST_LISTENER_REACHED'});};
try{
 const entry=process.argv[2];
 if(entry==='tenant'){const db=await import('../../src/shared/db');db.init();db.closeAllConnections();}
 else if(entry==='catalog'){const platform=await import('../../src/platform/platform');platform.platformDb();platform._resetPlatformDb();}
 else if(entry==='server')await import('../../server');
 else if(entry==='maintenance')await import('../../scripts/migrate-all');
 else throw new Error('Unknown runtime probe entry');
 console.log('RUNTIME_RESULT '+JSON.stringify({state:'admitted',node:process.versions.node}));process.exit(0);
}catch(error){const e=error as Error&{code?:string};console.log('RUNTIME_RESULT '+JSON.stringify({state:'refused',node:process.versions.node,code:e.code,message:e.message}));process.exit(1);}
