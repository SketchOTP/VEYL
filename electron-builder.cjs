'use strict';
const {APP_FILES}=require('./scripts/package-policy.cjs');
// Syntax follows electron-builder 26.15.3. No updater or publishing credentials are configured.
module.exports={
 appId:'io.github.SketchOTP.VEYL',productName:'VEYL',asar:false,
 directories:{output:'dist',buildResources:'assets'},
 files:[...APP_FILES],
 extraFiles:[{from:'scripts/launch-veyl',to:'launch-veyl'},{from:'scripts/sandbox-helper.sh',to:'sandbox-helper.sh'}],
 afterPack:'scripts/after-pack.cjs',publish:null,
 linux:{target:[{target:'deb',arch:['x64']},{target:'tar.gz',arch:['x64']}],
  executableName:'veyl',icon:'assets/512x512.png',category:'System',syncDesktopName:true,
  artifactName:'VEYL-${version}-${arch}.${ext}',maintainer:'SketchOTP <sketchotp@gmail.com>',
  synopsis:'A visual file explorer with a guarded AI assistant',
  desktop:{entry:{Name:'VEYL',GenericName:'File Explorer',Comment:'Explore and organize files with VEYL',
   TryExec:'/opt/VEYL/veyl',
   StartupWMClass:'io.github.SketchOTP.VEYL',Categories:'System;FileTools;FileManager;',Keywords:'Files;Folders;Assistant;Explorer;VEYL;',Terminal:'false'}}},
 deb:{packageName:'veyl',priority:'optional',afterInstall:'scripts/deb-after-install.sh',afterRemove:'scripts/deb-after-remove.sh',
  appArmorProfile:'scripts/apparmor-unused',recommends:[],
  depends:['python3 (>= 3.12)','coreutils (>= 9.4)','xdg-utils','desktop-file-utils','libsecret-1-0','libgtk-3-0t64','libnotify4','libnss3','libnspr4','libxss1','libxtst6','libatspi2.0-0t64','libuuid1','libasound2t64','libatk1.0-0t64','libatk-bridge2.0-0t64','libcups2t64','libdrm2','libgbm1','libxkbcommon0','libx11-6','libxcomposite1','libxdamage1','libxrandr2','libc6 (>= 2.39)']}
};
