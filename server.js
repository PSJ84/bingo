const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
const rooms = new Map();
const playerSessions = new Map(); // playerId -> { roomCode, socketId }

function generatePlayerId() {
  return crypto.randomUUID();
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎱 빙고 게임 서버 시작!`);
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
