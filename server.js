const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Estado de cada sala
const salas = {};

function criarSala(id) {
  return {
    id,
    jogadores: [],       // [ws, ws]
    papeis: [],          // ['escolhedor', 'adivinhador']
    palavra: null,
    letrasUsadas: [],
    erros: 0,
    maxErros: 6,
    fase: 'aguardando',  // aguardando | escolhendo | jogando | fim
    rodada: 1,
  };
}

function enviar(ws, dados) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(dados));
  }
}

function broadcast(sala, dados) {
  sala.jogadores.forEach(j => enviar(j, dados));
}

function estadoVisivel(sala, idx) {
  const palavra = sala.palavra;
  const revelada = palavra
    ? palavra.split('').map(l => (sala.letrasUsadas.includes(l.toLowerCase()) ? l : '_'))
    : [];
  return {
    type: 'estado',
    fase: sala.fase,
    papel: sala.papeis[idx],
    rodada: sala.rodada,
    revelada,
    letrasUsadas: sala.letrasUsadas,
    erros: sala.erros,
    maxErros: sala.maxErros,
    totalLetras: palavra ? palavra.length : 0,
  };
}

function verificarVitoria(sala) {
  const palavra = sala.palavra.toLowerCase();
  return palavra.split('').every(l => sala.letrasUsadas.includes(l));
}

function proximaRodada(sala) {
  // Troca os papéis
  sala.papeis.reverse();
  sala.palavra = null;
  sala.letrasUsadas = [];
  sala.erros = 0;
  sala.fase = 'escolhendo';
  sala.rodada += 1;

  sala.jogadores.forEach((j, i) => {
    enviar(j, estadoVisivel(sala, i));
    if (sala.papeis[i] === 'escolhedor') {
      enviar(j, { type: 'aviso', msg: 'É a sua vez de escolher uma palavra!' });
    } else {
      enviar(j, { type: 'aviso', msg: 'Aguarda enquanto o outro jogador escolhe a palavra...' });
    }
  });
}

wss.on('connection', (ws) => {
  ws.salaId = null;
  ws.idx = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Entrar numa sala
    if (msg.type === 'entrar') {
      const salaId = msg.sala || 'default';
      if (!salas[salaId]) salas[salaId] = criarSala(salaId);
      const sala = salas[salaId];

      if (sala.jogadores.length >= 2) {
        enviar(ws, { type: 'erro', msg: 'Sala cheia! Usa outro código de sala.' });
        return;
      }

      ws.salaId = salaId;
      ws.idx = sala.jogadores.length;
      sala.jogadores.push(ws);

      if (sala.jogadores.length === 1) {
        sala.papeis[0] = 'escolhedor';
        enviar(ws, { type: 'aviso', msg: 'Aguardando o segundo jogador entrar...' });
        enviar(ws, { type: 'info', jogador: 1 });
      } else {
        sala.papeis[1] = 'adivinhador';
        sala.fase = 'escolhendo';
        enviar(ws, { type: 'info', jogador: 2 });
        sala.jogadores.forEach((j, i) => {
          enviar(j, estadoVisivel(sala, i));
          if (sala.papeis[i] === 'escolhedor') {
            enviar(j, { type: 'aviso', msg: 'Escolhe uma palavra para o outro adivinhar!' });
          } else {
            enviar(j, { type: 'aviso', msg: 'Aguarda enquanto o outro jogador escolhe a palavra...' });
          }
        });
      }
      return;
    }

    const sala = salas[ws.salaId];
    if (!sala) return;
    const idx = ws.idx;

    // Escolher palavra
    if (msg.type === 'palavra') {
      if (sala.fase !== 'escolhendo') return;
      if (sala.papeis[idx] !== 'escolhedor') return;
      const palavra = msg.palavra.trim().toUpperCase();
      if (!palavra || palavra.length < 2) {
        enviar(ws, { type: 'erro', msg: 'Palavra muito curta!' });
        return;
      }
      sala.palavra = palavra;
      sala.letrasUsadas = [];
      sala.erros = 0;
      sala.fase = 'jogando';

      sala.jogadores.forEach((j, i) => {
        enviar(j, estadoVisivel(sala, i));
        if (sala.papeis[i] === 'adivinhador') {
          enviar(j, { type: 'aviso', msg: 'A palavra foi escolhida! Começa a adivinhar.' });
        } else {
          enviar(j, { type: 'aviso', msg: 'Palavra enviada! Aguarda o outro adivinhar.' });
        }
      });
      return;
    }

    // Adivinhar letra
    if (msg.type === 'letra') {
      if (sala.fase !== 'jogando') return;
      if (sala.papeis[idx] !== 'adivinhador') return;
      const letra = msg.letra.toLowerCase();
      if (!letra.match(/^[a-záéíóúàâêôãõüç]$/i)) return;
      if (sala.letrasUsadas.includes(letra)) {
        enviar(ws, { type: 'aviso', msg: 'Já tentaste essa letra!' });
        return;
      }

      sala.letrasUsadas.push(letra);
      const acertou = sala.palavra.toLowerCase().includes(letra);
      if (!acertou) sala.erros++;

      // Verifica fim
      if (verificarVitoria(sala)) {
        sala.fase = 'fim';
        sala.jogadores.forEach((j, i) => {
          enviar(j, estadoVisivel(sala, i));
        });
        broadcast(sala, { type: 'fim', resultado: 'adivinhador_venceu', palavra: sala.palavra });
        setTimeout(() => proximaRodada(sala), 3000);
        return;
      }

      if (sala.erros >= sala.maxErros) {
        sala.fase = 'fim';
        sala.jogadores.forEach((j, i) => {
          enviar(j, estadoVisivel(sala, i));
        });
        broadcast(sala, { type: 'fim', resultado: 'escolhedor_venceu', palavra: sala.palavra });
        setTimeout(() => proximaRodada(sala), 3000);
        return;
      }

      sala.jogadores.forEach((j, i) => {
        enviar(j, estadoVisivel(sala, i));
        enviar(j, { type: 'aviso', msg: acertou ? `✅ Letra "${letra.toUpperCase()}" está na palavra!` : `❌ Letra "${letra.toUpperCase()}" não está na palavra.` });
      });
      return;
    }
  });

  ws.on('close', () => {
    const sala = salas[ws.salaId];
    if (sala) {
      broadcast(sala, { type: 'aviso', msg: 'O outro jogador saiu. Aguardando reconexão...' });
      sala.jogadores = sala.jogadores.filter(j => j !== ws);
      sala.papeis = [];
      sala.fase = 'aguardando';
      sala.palavra = null;
      sala.letrasUsadas = [];
      sala.erros = 0;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Jogo da Forca rodando na porta ${PORT}`);
});