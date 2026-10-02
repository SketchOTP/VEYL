#!/usr/bin/env node
'use strict';
const {verifyPackage}=require('./package-policy.cjs');
if(process.argv.length!==3){process.stderr.write('Usage: node scripts/verify-package.cjs /path/to/unpacked-release\n');process.exitCode=1;}
else verifyPackage(process.argv[2]).then(result=>process.stdout.write(`VEYL ${result.version}: ${result.appFiles} allowlisted app files and launcher manifest verified.\n`)).catch(error=>{process.stderr.write(`VEYL package verification failed: ${error.message}\n`);process.exitCode=1;});
