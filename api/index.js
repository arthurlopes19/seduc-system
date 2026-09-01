'use strict';

/*
 * Ponto de entrada da Vercel.
 *
 * A plataforma importa este arquivo como uma função serverless e cuida de
 * escutar a porta — por isso `server.js` só chama `listen()` quando é
 * executado direto (`npm start`), e aqui apenas exporta o app do Express.
 *
 * O roteamento de /api/* para cá está em `vercel.json`; os arquivos de
 * `public/` a Vercel serve sozinha, direto do CDN.
 */

module.exports = require('../server.js');
