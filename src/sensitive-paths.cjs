'use strict';
// Hidden ancestors and metadata-confirmed hidden directories protect unfamiliar stores.
// This is agent-only policy; manual explorer operations do not use this exclusion.
function sensitive(file,directory=false){return /(?:^|\/)\.[^/]+\/|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(file)||directory&&/(?:^|\/)\.[^/]+\/?$/.test(file);}
module.exports={sensitive};
