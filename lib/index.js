"use strict";
import gradient from 'gradient-string';
import makeWASocket from './Socket/index.js';
const banner = `
T E R I M   K A S I H 
S U D A H   P A K A I 
B A I L E Y   R A M Z
TANGGAL UPDATE: 27,6,2026
DEVELOPER: RAMZ NOT DEV
MY FRIENDS
RAMZ OFFICIAL
MBAPE
VANNO
TAKESHI
LYNZZZ
`;

const info = `
NEW UPDATE BAILEY RAMZ V2 NIE. 
JANGAN LUPA SUPPORT RAMZ TERUS.
`;

// Print banner with gradient
console.log(gradient(['#00D4FF', '#0099FF', '#00D4FF'])(banner));

// Print info with gradient
console.log(gradient(['#FFD700', '#FF6B6B', '#4ECDC4'])(info));

// Startup message
console.log(gradient(['#00FF88', '#FFFFFF'])('\n🎯 Initializing Baileys Socket Connection...\n'));

export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Store/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export * from './Socket/index.js';
export default makeWASocket;
