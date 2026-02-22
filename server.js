const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Google Cloud TTS 프록시 ──
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || 'AIzaSyAeU4yHYqYDoNvWGA-axG2XcV77t7F1qcM';

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text || text.length > 200) {
    return res.status(400).json({ error: 'Invalid text' });
  }
  try {
    const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ko-KR', name: 'ko-KR-Neural2-A' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.85 },
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('TTS API error:', err);
      return res.status(500).json({ error: 'TTS failed' });
    }
    const data = await response.json();
    res.json({ audioContent: data.audioContent });
  } catch (e) {
    console.error('TTS fetch error:', e);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ── 전적 파일 저장/로드 ──
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('전적 파일 로드 실패:', e);
  }
  return {};
}

function saveStats() {
  try {
    const data = {};
    for (const [code, room] of rooms) {
      if (room.records.size > 0) {
        data[code] = {
          winLines: room.winLines,
          numberRange: room.numberRange,
          players: Object.fromEntries(room.records),
          lastActivity: new Date().toISOString(),
        };
      }
    }
    fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('전적 파일 저장 실패:', e);
  }
}

// ── 게임 상태 저장소 ──
const rooms = new Map();           // 빙고 방
const quizRooms = new Map();       // 퀴즈 방
const playerSessions = new Map();  // playerId -> { roomCode, socketId, type }

function generatePlayerId() {
  return crypto.randomUUID();
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code) || quizRooms.has(code));
  return code;
}

// ── 퀴즈 헬퍼 함수 ──
const QUIZ_DIFFICULTIES = {
  easy: { min: 1, max: 10, ops: ['+'] },
  normal: { min: 1, max: 20, ops: ['+', '-'] },
  hard: { min: 1, max: 50, ops: ['+', '-'] },
};

function generateQuizProblem(difficulty) {
  const config = QUIZ_DIFFICULTIES[difficulty] || QUIZ_DIFFICULTIES.easy;
  const op = config.ops[Math.floor(Math.random() * config.ops.length)];
  let a, b, answer;
  if (op === '+') {
    a = Math.floor(Math.random() * config.max) + config.min;
    b = Math.floor(Math.random() * config.max) + config.min;
    answer = a + b;
  } else {
    a = Math.floor(Math.random() * config.max) + config.min;
    b = Math.floor(Math.random() * a) + 1;
    answer = a - b;
  }
  const choices = generateQuizChoices(answer);
  return { a, b, op, answer, choices, id: crypto.randomUUID().slice(0, 8) };
}

function generateQuizChoices(answer) {
  const choices = new Set([answer]);
  while (choices.size < 4) {
    const offset = Math.floor(Math.random() * 10) + 1;
    const wrong = answer + (Math.random() > 0.5 ? offset : -offset);
    if (wrong >= 0 && wrong !== answer) {
      choices.add(wrong);
    }
  }
  return [...choices].sort(() => Math.random() - 0.5);
}

function emitQuizPlayerList(room) {
  const players = [];
  for (const [pid, p] of room.players) {
    players.push({
      name: p.name,
      emoji: p.emoji,
      score: p.score,
      isHost: pid === room.host,
      connected: p.connected,
    });
  }
  io.to('quiz:' + room.code).emit('quiz:player-list', {
    players,
    code: room.code,
    difficulty: room.difficulty,
    totalRounds: room.totalRounds,
  });
}

function generateBoard(numberRange) {
  const pool = [];
  for (let i = 1; i <= numberRange; i++) pool.push(i);
  shuffle(pool);
  const picked = pool.slice(0, 25);
  const board = [];
  for (let r = 0; r < 5; r++) {
    board.push(picked.slice(r * 5, r * 5 + 5));
  }
  return board;
}

function checkBingo(marked) {
  let lines = 0;
  for (let r = 0; r < 5; r++) {
    if (marked[r].every(v => v)) lines++;
  }
  for (let c = 0; c < 5; c++) {
    let col = true;
    for (let r = 0; r < 5; r++) {
      if (!marked[r][c]) { col = false; break; }
    }
    if (col) lines++;
  }
  let d1 = true, d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marked[i][i]) d1 = false;
    if (!marked[i][4 - i]) d2 = false;
  }
  if (d1) lines++;
  if (d2) lines++;
  return lines;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function emitPlayerList(room) {
  const players = [];
  for (const [pid, p] of room.players) {
    players.push({
      name: p.name,
      isHost: pid === room.host,
      connected: p.connected,
    });
  }

  const rankings = [...room.records.entries()]
    .map(([name, r]) => ({ name, ...r }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses);

  io.to(room.code).emit('player-list', {
    players,
    code: room.code,
    winLines: room.winLines,
    numberRange: room.numberRange,
    rankings,
  });
}

function buildPlayerStates(room, forPlayerId) {
  const states = [];
  for (const [pid, player] of room.players) {
    states.push({
      name: player.name,
      bingoLines: player.bingoLines,
      isMe: pid === forPlayerId,
      connected: player.connected,
    });
  }
  return states;
}

// ── 방 목록 브로드캐스트 ──
function getBingoRoomList() {
  const list = [];
  for (const [code, room] of rooms) {
    if (room.started) continue;
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    if (connectedCount === 0) continue;
    const hostPlayer = room.players.get(room.host);
    list.push({
      code,
      hostName: hostPlayer ? hostPlayer.name : '???',
      playerCount: connectedCount,
      maxPlayers: 4,
    });
  }
  return list;
}

function getQuizRoomList() {
  const list = [];
  for (const [code, room] of quizRooms) {
    if (room.status !== 'waiting') continue;
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    if (connectedCount === 0) continue;
    const hostPlayer = room.players.get(room.host);
    list.push({
      code,
      hostName: hostPlayer ? hostPlayer.name : '???',
      playerCount: connectedCount,
      maxPlayers: 4,
    });
  }
  return list;
}

function broadcastBingoRoomList() {
  io.emit('bingo:room-list', getBingoRoomList());
}

function broadcastQuizRoomList() {
  io.emit('quiz:room-list', getQuizRoomList());
}

function advanceTurn(room) {
  const connectedPlayers = room.turnOrder.filter(pid => {
    const p = room.players.get(pid);
    return p && p.connected;
  });
  if (connectedPlayers.length === 0) return;

  let attempts = 0;
  do {
    room.currentTurn = (room.currentTurn + 1) % room.turnOrder.length;
    attempts++;
  } while (
    !room.players.get(room.turnOrder[room.currentTurn]).connected &&
    attempts < room.turnOrder.length
  );
}

// ── 서버 시작 시 전적 복원 ──
const allStats = loadStats();
for (const [code, data] of Object.entries(allStats)) {
  rooms.set(code, {
    code,
    host: null,
    players: new Map(),
    calledNumbers: [],
    remainingNumbers: [],
    started: false,
    currentTurn: 0,
    turnOrder: [],
    winner: null,
    winLines: data.winLines || 3,
    numberRange: data.numberRange || 25,
    records: new Map(Object.entries(data.players || {})),
  });
}

// ── Socket.IO 이벤트 ──
io.on('connection', (socket) => {
  console.log('연결:', socket.id);

  // 연결 시 현재 방 목록 전송
  socket.emit('bingo:room-list', getBingoRoomList());
  socket.emit('quiz:room-list', getQuizRoomList());

  // 방 만들기
  socket.on('create-room', ({ playerName, playerId }) => {
    if (!playerId) playerId = generatePlayerId();

    const code = generateRoomCode();
    const room = {
      code,
      host: playerId,
      players: new Map(),
      calledNumbers: [],
      remainingNumbers: [],
      started: false,
      currentTurn: 0,
      turnOrder: [],
      winner: null,
      winLines: 3,
      numberRange: 25,
      records: new Map(),
    };

    for (let i = 1; i <= 25; i++) room.remainingNumbers.push(i);
    shuffle(room.remainingNumbers);

    room.players.set(playerId, {
      name: playerName,
      board: null,
      marked: null,
      bingoLines: 0,
      socketId: socket.id,
      connected: true,
    });

    rooms.set(code, room);
    socket.join(code);
    socket.playerId = playerId;
    socket.roomCode = code;
    playerSessions.set(playerId, { roomCode: code, socketId: socket.id });

    socket.emit('room-created', { code, playerName, playerId });
    emitPlayerList(room);
    broadcastBingoRoomList();
  });

  // 방 참가 (+ 재접속)
  socket.on('join-room', ({ code, playerName, playerId }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('error-msg', '방을 찾을 수 없어요! 코드를 다시 확인해주세요.');
      return;
    }

    // 재접속 확인
    if (playerId && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      player.socketId = socket.id;
      player.connected = true;
      socket.join(code);
      socket.playerId = playerId;
      socket.roomCode = code;
      playerSessions.set(playerId, { roomCode: code, socketId: socket.id });

      const isHost = room.host === playerId;

      if (room.started && !room.winner) {
        // 게임 진행 중 재접속
        socket.emit('game-restored', {
          board: player.board,
          marked: player.marked,
          bingoLines: player.bingoLines,
          turnOrder: room.turnOrder.map(pid => room.players.get(pid).name),
          myTurnIndex: room.turnOrder.indexOf(playerId),
          currentTurn: room.currentTurn,
          calledNumbers: room.calledNumbers,
          playerStates: buildPlayerStates(room, playerId),
          winLines: room.winLines,
          numberRange: room.numberRange,
          winner: null,
          isHost,
        });
      } else if (room.started && room.winner) {
        // 게임 종료 상태 재접속
        const winnerPlayer = room.players.get(room.winner);
        socket.emit('game-restored', {
          board: player.board,
          marked: player.marked,
          bingoLines: player.bingoLines,
          turnOrder: room.turnOrder.map(pid => room.players.get(pid).name),
          myTurnIndex: room.turnOrder.indexOf(playerId),
          currentTurn: room.currentTurn,
          calledNumbers: room.calledNumbers,
          playerStates: buildPlayerStates(room, playerId),
          winLines: room.winLines,
          numberRange: room.numberRange,
          winner: winnerPlayer ? { name: winnerPlayer.name, lines: winnerPlayer.bingoLines } : null,
          isHost,
        });
      } else {
        // 대기실 재접속
        socket.emit('room-joined', { code, playerName: player.name, playerId, isHost });
        emitPlayerList(room);
      }

      io.to(code).emit('player-reconnected', { name: player.name });
      emitPlayerList(room);
      return;
    }

    // 새 플레이어 참가
    if (room.started) {
      socket.emit('error-msg', '이미 게임이 시작되었어요!');
      return;
    }

    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    if (connectedCount >= 4) {
      socket.emit('error-msg', '방이 가득 찼어요! (최대 4명)');
      return;
    }

    if (!playerId) playerId = generatePlayerId();

    room.players.set(playerId, {
      name: playerName,
      board: null,
      marked: null,
      bingoLines: 0,
      socketId: socket.id,
      connected: true,
    });

    // 방장이 없으면(복원된 방) 첫 입장자가 방장
    if (!room.host) {
      room.host = playerId;
    }

    socket.join(code);
    socket.playerId = playerId;
    socket.roomCode = code;
    playerSessions.set(playerId, { roomCode: code, socketId: socket.id });

    const isHost = room.host === playerId;
    socket.emit('room-joined', { code, playerName, playerId, isHost });
    emitPlayerList(room);
    broadcastBingoRoomList();
  });

  // 승리 줄 수 설정 (방장만)
  socket.on('set-win-lines', (lines) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.playerId) return;
    if (![2, 3, 4, 5].includes(lines)) return;
    room.winLines = lines;
    io.to(room.code).emit('win-lines-updated', lines);
  });

  // 숫자 범위 설정 (방장만)
  socket.on('set-number-range', (range) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.playerId) return;
    if (![25, 50, 75].includes(range)) return;
    room.numberRange = range;
    io.to(room.code).emit('number-range-updated', range);
  });

  // 게임 시작 (방장만)
  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.playerId) return;

    const connectedPlayers = [...room.players.entries()].filter(([, p]) => p.connected);
    if (connectedPlayers.length < 2) {
      socket.emit('error-msg', '최소 2명이 필요해요!');
      return;
    }

    room.started = true;
    broadcastBingoRoomList();
    room.turnOrder = connectedPlayers.map(([pid]) => pid);
    shuffle(room.turnOrder);
    room.currentTurn = 0;
    room.calledNumbers = [];
    room.remainingNumbers = [];
    for (let i = 1; i <= room.numberRange; i++) room.remainingNumbers.push(i);
    shuffle(room.remainingNumbers);
    room.winner = null;

    for (const [pid, player] of room.players) {
      if (player.connected) {
        player.board = generateBoard(room.numberRange);
        player.marked = Array.from({ length: 5 }, () => Array(5).fill(false));
        player.bingoLines = 0;
      }
    }

    for (const [pid, player] of room.players) {
      if (!player.connected) continue;
      const turnIndex = room.turnOrder.indexOf(pid);
      io.to(player.socketId).emit('game-started', {
        board: player.board,
        turnOrder: room.turnOrder.map(id => room.players.get(id).name),
        myTurnIndex: turnIndex,
        currentTurn: room.currentTurn,
        winLines: room.winLines,
        numberRange: room.numberRange,
        isHost: pid === room.host,
      });
    }
  });

  // 번호 부르기
  socket.on('call-number', (number) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started || room.winner) return;

    const playerId = socket.playerId;
    if (room.turnOrder[room.currentTurn] !== playerId) {
      socket.emit('error-msg', '아직 내 차례가 아니에요!');
      return;
    }

    if (room.calledNumbers.includes(number)) {
      socket.emit('error-msg', '이미 나온 번호예요!');
      return;
    }

    room.calledNumbers.push(number);
    room.remainingNumbers = room.remainingNumbers.filter(n => n !== number);

    const callerName = room.players.get(playerId).name;

    // 모든 플레이어 보드에서 마킹
    const playerStates = [];
    for (const [pid, player] of room.players) {
      if (!player.board) continue;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (player.board[r][c] === number) {
            player.marked[r][c] = true;
          }
        }
      }
      player.bingoLines = checkBingo(player.marked);
      playerStates.push({
        id: pid,
        name: player.name,
        bingoLines: player.bingoLines,
        connected: player.connected,
      });
    }

    // 빙고 달성 확인
    let winnerInfo = null;
    for (const [pid, player] of room.players) {
      if (player.bingoLines >= room.winLines) {
        room.winner = pid;
        winnerInfo = { id: pid, name: player.name, lines: player.bingoLines };

        // 전적 업데이트
        for (const [rpid, rplayer] of room.players) {
          if (!rplayer.board) continue;
          const name = rplayer.name;
          if (!room.records.has(name)) {
            room.records.set(name, { wins: 0, losses: 0, currentStreak: 0, maxStreak: 0 });
          }
          const rec = room.records.get(name);
          if (rpid === pid) {
            rec.wins++;
            rec.currentStreak++;
            rec.maxStreak = Math.max(rec.maxStreak, rec.currentStreak);
          } else {
            rec.losses++;
            rec.currentStreak = 0;
          }
        }
        saveStats();
        break;
      }
    }

    // 다음 턴
    if (!winnerInfo) {
      advanceTurn(room);
    }

    // 결과 전송
    for (const [pid, player] of room.players) {
      if (!player.connected) continue;
      io.to(player.socketId).emit('number-called', {
        number,
        callerName,
        calledNumbers: room.calledNumbers,
        myMarked: player.marked,
        myBingoLines: player.bingoLines,
        currentTurn: room.currentTurn,
        playerStates: playerStates.map(ps => ({
          name: ps.name,
          bingoLines: ps.bingoLines,
          isMe: ps.id === pid,
          connected: ps.connected,
        })),
        winner: winnerInfo ? { name: winnerInfo.name, lines: winnerInfo.lines } : null,
        rankings: winnerInfo ? [...room.records.entries()]
          .map(([name, r]) => ({ name, ...r }))
          .sort((a, b) => b.wins - a.wins || a.losses - b.losses) : null,
      });
    }
  });

  // 새 게임 / 재시작 (방장만)
  socket.on('new-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    if (room.host !== socket.playerId) return;

    room.calledNumbers = [];
    room.remainingNumbers = [];
    for (let i = 1; i <= room.numberRange; i++) room.remainingNumbers.push(i);
    shuffle(room.remainingNumbers);
    room.started = false;
    room.winner = null;
    room.currentTurn = 0;
    room.turnOrder = [];

    for (const [pid, player] of room.players) {
      player.board = null;
      player.marked = null;
      player.bingoLines = 0;
    }

    io.to(room.code).emit('game-reset');
    emitPlayerList(room);
    broadcastBingoRoomList();
  });

  // 방 닫기 (방장만)
  socket.on('close-room', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.playerId) return;

    const code = room.code;

    // 모든 플레이어에게 알림
    io.to(code).emit('room-closed');

    // playerSessions 정리
    for (const [pid] of room.players) {
      playerSessions.delete(pid);
    }

    // 방 삭제
    rooms.delete(code);
    saveStats();
    broadcastBingoRoomList();
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('연결 해제:', socket.id);
    const playerId = socket.playerId;
    const code = socket.roomCode;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player) return;

    player.connected = false;
    playerSessions.delete(playerId);

    // 게임 중 턴 넘기기
    if (room.started && !room.winner) {
      if (room.turnOrder[room.currentTurn] === playerId) {
        advanceTurn(room);
        // 턴 변경 알림
        for (const [pid, p] of room.players) {
          if (!p.connected) continue;
          io.to(p.socketId).emit('turn-updated', {
            currentTurn: room.currentTurn,
          });
        }
      }
    }

    io.to(code).emit('player-disconnected', { name: player.name });
    emitPlayerList(room);
    broadcastBingoRoomList();
  });

  // ════════════════════════════════════════
  // ── 수학 퀴즈 Socket.IO 이벤트 ──
  // ════════════════════════════════════════

  socket.on('quiz:create-room', ({ playerName, playerId, emoji }) => {
    if (!playerId) playerId = generatePlayerId();
    const code = generateRoomCode();
    const room = {
      code,
      host: playerId,
      players: new Map(),
      difficulty: 'easy',
      totalRounds: 10,
      currentProblem: null,
      currentRound: 0,
      answers: {},
      status: 'waiting',
      roundWinner: null,
    };

    room.players.set(playerId, {
      name: playerName,
      emoji: emoji || '🦁',
      score: 0,
      socketId: socket.id,
      connected: true,
    });

    quizRooms.set(code, room);
    socket.join('quiz:' + code);
    socket.playerId = playerId;
    socket.quizRoomCode = code;
    playerSessions.set(playerId, { roomCode: code, socketId: socket.id, type: 'quiz' });

    socket.emit('quiz:room-created', { code, playerName, playerId });
    emitQuizPlayerList(room);
    broadcastQuizRoomList();
  });

  socket.on('quiz:join-room', ({ code, playerName, playerId, emoji }) => {
    const room = quizRooms.get(code);
    if (!room) {
      socket.emit('quiz:error-msg', '방을 찾을 수 없어요!');
      return;
    }

    // 재접속
    if (playerId && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      player.socketId = socket.id;
      player.connected = true;
      socket.join('quiz:' + code);
      socket.playerId = playerId;
      socket.quizRoomCode = code;
      playerSessions.set(playerId, { roomCode: code, socketId: socket.id, type: 'quiz' });

      const isHost = room.host === playerId;

      if (room.status === 'playing' || room.status === 'roundResult') {
        socket.emit('quiz:game-restored', {
          status: room.status,
          difficulty: room.difficulty,
          totalRounds: room.totalRounds,
          currentRound: room.currentRound,
          currentProblem: room.currentProblem,
          myAnswer: room.answers[playerId] || null,
          roundWinner: room.roundWinner,
          players: [...room.players.values()].map(p => ({
            name: p.name, emoji: p.emoji, score: p.score, connected: p.connected,
          })),
          isHost,
          playerId,
        });
      } else if (room.status === 'finished') {
        socket.emit('quiz:game-finished', {
          players: [...room.players.values()]
            .map(p => ({ name: p.name, emoji: p.emoji, score: p.score }))
            .sort((a, b) => b.score - a.score),
          isHost,
          playerId,
        });
      } else {
        socket.emit('quiz:room-joined', { code, playerName: player.name, playerId, isHost });
        emitQuizPlayerList(room);
      }
      return;
    }

    // 새 참가
    if (room.status !== 'waiting') {
      socket.emit('quiz:error-msg', '이미 게임이 시작되었어요!');
      return;
    }
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    if (connectedCount >= 4) {
      socket.emit('quiz:error-msg', '방이 가득 찼어요! (최대 4명)');
      return;
    }

    if (!playerId) playerId = generatePlayerId();

    room.players.set(playerId, {
      name: playerName,
      emoji: emoji || '🦁',
      score: 0,
      socketId: socket.id,
      connected: true,
    });

    if (!room.host) room.host = playerId;

    socket.join('quiz:' + code);
    socket.playerId = playerId;
    socket.quizRoomCode = code;
    playerSessions.set(playerId, { roomCode: code, socketId: socket.id, type: 'quiz' });

    const isHost = room.host === playerId;
    socket.emit('quiz:room-joined', { code, playerName, playerId, isHost });
    emitQuizPlayerList(room);
    broadcastQuizRoomList();
  });

  socket.on('quiz:set-difficulty', (difficulty) => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;
    if (!['easy', 'normal', 'hard'].includes(difficulty)) return;
    room.difficulty = difficulty;
    io.to('quiz:' + room.code).emit('quiz:difficulty-updated', difficulty);
  });

  socket.on('quiz:set-rounds', (rounds) => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;
    if (![5, 10, 15, 20].includes(rounds)) return;
    room.totalRounds = rounds;
    io.to('quiz:' + room.code).emit('quiz:rounds-updated', rounds);
  });

  socket.on('quiz:start-game', () => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    if (connectedCount < 2) {
      socket.emit('quiz:error-msg', '최소 2명이 필요해요!');
      return;
    }

    // 카운트다운 시작
    room.status = 'countdown';
    broadcastQuizRoomList();
    for (const [, p] of room.players) p.score = 0;
    io.to('quiz:' + room.code).emit('quiz:countdown', 3);

    let count = 3;
    const cdInterval = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(cdInterval);
        // 첫 문제 출제
        room.status = 'playing';
        room.currentRound = 1;
        room.answers = {};
        room.roundWinner = null;
        room.currentProblem = generateQuizProblem(room.difficulty);

        io.to('quiz:' + room.code).emit('quiz:game-started', {
          difficulty: room.difficulty,
          totalRounds: room.totalRounds,
          currentRound: room.currentRound,
          problem: room.currentProblem,
          players: [...room.players.values()].map(p => ({
            name: p.name, emoji: p.emoji, score: p.score, connected: p.connected,
          })),
        });
      } else {
        io.to('quiz:' + room.code).emit('quiz:countdown', count);
      }
    }, 1000);
  });

  socket.on('quiz:submit-answer', (choice) => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.status !== 'playing') return;
    const playerId = socket.playerId;
    if (room.answers[playerId]) return; // 이미 답변함

    const isCorrect = choice === room.currentProblem.answer;
    room.answers[playerId] = { choice, correct: isCorrect, time: Date.now() };

    // 모든 연결된 플레이어가 답변했는지 확인
    const connectedPlayers = [...room.players.entries()].filter(([, p]) => p.connected);
    const allAnswered = connectedPlayers.every(([pid]) => room.answers[pid]);

    if (allAnswered) {
      // 라운드 결과 처리
      const correctAnswers = Object.entries(room.answers)
        .filter(([, a]) => a.correct)
        .sort((a, b) => a[1].time - b[1].time);

      if (correctAnswers.length > 0) {
        const winnerId = correctAnswers[0][0];
        room.roundWinner = winnerId;
        const winner = room.players.get(winnerId);
        if (winner) winner.score++;
      } else {
        room.roundWinner = null;
      }

      room.status = 'roundResult';

      // 각 플레이어의 답변 정보
      const answersInfo = {};
      for (const [pid, ans] of Object.entries(room.answers)) {
        const p = room.players.get(pid);
        answersInfo[pid] = { name: p ? p.name : '?', ...ans };
      }

      const roundWinnerPlayer = room.roundWinner ? room.players.get(room.roundWinner) : null;

      io.to('quiz:' + room.code).emit('quiz:round-result', {
        problem: room.currentProblem,
        roundWinner: roundWinnerPlayer ? { name: roundWinnerPlayer.name, emoji: roundWinnerPlayer.emoji } : null,
        answers: answersInfo,
        players: [...room.players.values()].map(p => ({
          name: p.name, emoji: p.emoji, score: p.score, connected: p.connected,
        })),
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
      });
    }
  });

  socket.on('quiz:next-round', () => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;

    if (room.currentRound >= room.totalRounds) {
      // 게임 종료
      room.status = 'finished';
      const sorted = [...room.players.values()]
        .map(p => ({ name: p.name, emoji: p.emoji, score: p.score }))
        .sort((a, b) => b.score - a.score);

      // 각 플레이어에게 개별 전송 (방장 여부 구분)
      for (const [pid, p] of room.players) {
        if (!p.connected) continue;
        io.to(p.socketId).emit('quiz:game-finished', {
          players: sorted,
          isHost: pid === room.host,
        });
      }
      return;
    }

    // 다음 문제
    room.currentRound++;
    room.answers = {};
    room.roundWinner = null;
    room.status = 'playing';
    room.currentProblem = generateQuizProblem(room.difficulty);

    io.to('quiz:' + room.code).emit('quiz:next-problem', {
      currentRound: room.currentRound,
      problem: room.currentProblem,
      players: [...room.players.values()].map(p => ({
        name: p.name, emoji: p.emoji, score: p.score, connected: p.connected,
      })),
    });
  });

  socket.on('quiz:play-again', () => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;

    room.status = 'waiting';
    room.currentProblem = null;
    room.currentRound = 0;
    room.answers = {};
    room.roundWinner = null;
    for (const [, p] of room.players) p.score = 0;

    io.to('quiz:' + room.code).emit('quiz:game-reset');
    emitQuizPlayerList(room);
    broadcastQuizRoomList();
  });

  // 퀴즈 방 닫기 (방장만)
  socket.on('quiz:close-room', () => {
    const room = quizRooms.get(socket.quizRoomCode);
    if (!room || room.host !== socket.playerId) return;

    const code = room.code;

    // 모든 플레이어에게 알림
    io.to('quiz:' + code).emit('quiz:room-closed');

    // playerSessions 정리
    for (const [pid] of room.players) {
      playerSessions.delete(pid);
    }

    // 방 삭제
    quizRooms.delete(code);
    broadcastQuizRoomList();
  });

  // 퀴즈 disconnect 처리
  socket.on('disconnect', () => {
    const quizCode = socket.quizRoomCode;
    if (!quizCode) return;
    const room = quizRooms.get(quizCode);
    if (!room) return;
    const qPlayerId = socket.playerId;
    const player = room.players.get(qPlayerId);
    if (!player) return;

    player.connected = false;
    io.to('quiz:' + quizCode).emit('quiz:player-disconnected', { name: player.name });
    emitQuizPlayerList(room);
    broadcastQuizRoomList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 가족 게임 서버 시작!`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n같은 Wi-Fi에 있는 기기에서 접속하려면:`);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
