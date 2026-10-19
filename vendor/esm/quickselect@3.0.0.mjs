/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/quickselect@3.0.0/index.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
function x(n,s,o=0,c=n.length-1,u=p){for(;c>o;){if(c-o>600){const i=c-o+1,l=s-o+1,d=Math.log(i),h=.5*Math.exp(2*d/3),f=.5*Math.sqrt(d*h*(i-h)/i)*(l-i/2<0?-1:1),q=Math.max(o,Math.floor(s-l*h/i+f)),m=Math.min(c,Math.floor(s+(i-l)*h/i+f));x(n,s,q,m,u)}const e=n[s];let w=o,t=c;for(M(n,o,s),u(n[c],e)>0&&M(n,o,c);w<t;){for(M(n,w,t),w++,t--;u(n[w],e)<0;)w++;for(;u(n[t],e)>0;)t--}u(n[o],e)===0?M(n,o,t):(t++,M(n,t,c)),t<=s&&(o=t+1),s<=t&&(c=t-1)}}function M(n,s,o){const c=n[s];n[s]=n[o],n[o]=c}function p(n,s){return n<s?-1:n>s?1:0}export{x as default};
