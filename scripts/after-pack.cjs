'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {verifyPackage,verifyELF}=require('./package-policy.cjs');
module.exports=async function afterPack(context){if(context.electronPlatformName!=='linux')throw new Error('VEYL release packaging supports Linux only.');const root=context.appOutDir;
 const binary=path.join(root,'veyl-bin'),entry=path.join(root,'veyl'),launcher=path.join(root,'launch-veyl');
 const existing=await fs.lstat(binary).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(existing){if(!existing.isFile()||existing.isSymbolicLink()||!(await fs.readFile(entry)).equals(await fs.readFile(launcher)))throw new Error('Unexpected pre-existing packaged binary/launcher; refusing to overwrite.');await verifyELF(binary);}
 else{await verifyELF(entry);await fs.rename(entry,binary);await fs.copyFile(launcher,entry,require('node:fs').constants.COPYFILE_EXCL);}
 // Builder's supported generated Exec now points at veyl (our wrapper), never directly at the ELF.
 for(const file of ['launch-veyl','sandbox-helper.sh','veyl','veyl-bin','chrome-sandbox']){const stat=await fs.lstat(path.join(root,file));if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`Refusing non-regular build artifact: ${file}`);await fs.chmod(path.join(root,file),0o755);}
 // Portable artifacts keep the helper0755; Debian's root postinst handles its own helper.
 const result=await verifyPackage(root,{manifest:false});await fs.writeFile(path.join(root,'resources/release-manifest.json'),JSON.stringify(result,null,2)+'\n',{mode:0o644});
};
