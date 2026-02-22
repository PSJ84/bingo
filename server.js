const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── 게임 상태 저장소 ──
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateBoard() {
  // 1~25 숫자를 랜덤 배치한 5x5 빙고판
  const nums = [];
  for (let i = 1; i <= 25; i++) nums.push(i);
  // Fisher-Yates shuffle
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  const board = [];
  for (let r = 0; r < 5; r++) {
    board.push(nums.slice(r * 5, r * 5 + 5));
  }
  return board;
}

function checkBingo(marked) {
  // marked: 5x5 boolean 배열
  let lines = 0;

  // 가로 5줄
  for (let r = 0; r < 5; r++) {
    if (marked[r].every(v => v)) lines++;
  }
  // 세로 5줄
  for (let c = 0; c < 5; c++) {
    let col = true;
    for (let r = 0; r < 5; r++) {
      if (!marked[r][c]) { col = false; break; }
    }
    if (col) lines++;
  }
  // 대각선 2줄
  let d1 = true, d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marked[i][i]) d1 = false;
    if (!marked[i][4 - i]) d2 = false;
  }
  if (d1) lines++;
  if (d2) lines++;

  return lines;
}

// ── Socket.IO 이벤트 ──
io.on('connection', (socket) => {
  console.log('연결:', socket.id);

  // 방 만들기
  socket.on('create-room', (playerName) => {
    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      players: new Map(),
      calledNumbers: [],
      remainingNumbers: [],
      started: false,
      currentTurn: 0,
      turnOrder: [],
      winner: null,
    };
    // 1~25 숫자 풀
    for (let i = 1; i <= 25; i++) room.remainingNumbers.push(i);
    shuffle(room.remainingNumbers);

    room.players.set(socket.id, {
      name: playerName,
      board: null,
      marked: null,
      bingoLines: 0,
    });

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room-created', { code, playerName });
    emitPlayerList(room);
  });

  // 방 참가
  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('error-msg', '방을 찾을 수 없어요! 코드를 다시 확인해주세요.');
      return;
    }
    if (room.started) {
      socket.emit('error-msg', '이미 게임이 시작되었어요!');
      return;
    }
    if (room.players.size >= 4) {
      socket.emit('error-msg', '방이 가득 찼어요! (최대 4명)');
      return;
    }

    room.players.set(socket.id, {
      name: playerName,
      board: null,
      marked: null,
      bingoLines: 0,
    });

    socket.join(code);
    socket.roomCode = code;

    socket.emit('room-joined', { code, playerName });
    emitPlayerList(room);
  });

  // 게임 시작 (방장만)
  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    if (room.players.size < 2) {
      socket.emit('error-msg', '최소 2명이 필요해요!');
      return;
    }

    room.started = true;
    room.turnOrder = [...room.players.keys()];
    shuffle(room.turnOrder);
    room.currentTurn = 0;

    // 각 플레이어에게 빙고판 배정
    for (const [sid, player] of room.players) {
      player.board = generateBoard();
      player.marked = Array.from({ length: 5 }, () => Array(5).fill(false));
    }

    // 각 플레이어에게 게임 시작 알림 + 자기 보드 전송
    for (const [sid, player] of room.players) {
      const turnIndex = room.turnOrder.indexOf(sid);
      io.to(sid).emit('game-started', {
        board: player.board,
        turnOrder: room.turnOrder.map(id => room.players.get(id).name),
        myTurnIndex: turnIndex,
        currentTurn: room.currentTurn,
      });
    }
  });

  // 번호 부르기 (자기 턴에만)
  socket.on('call-number', (number) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started || room.winner) return;

    // 턴 확인
    if (room.turnOrder[room.currentTurn] !== socket.id) {
      socket.emit('error-msg', '아직 내 차례가 아니에요!');
      return;
    }

    // 이미 불린 번호인지 확인
    if (room.calledNumbers.includes(number)) {
      socket.emit('error-msg', '이미 나온 번호예요!');
      return;
    }

    room.calledNumbers.push(number);
    room.remainingNumbers = room.remainingNumbers.filter(n => n !== number);

    const callerName = room.players.get(socket.id).name;

    // 모든 플레이어의 보드에서 해당 번호 마킹
    const playerStates = [];
    for (const [sid, player] of room.players) {
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (player.board[r][c] === number) {
            player.marked[r][c] = true;
          }
        }
      }
      player.bingoLines = checkBingo(player.marked);
      playerStates.push({
        id: sid,
        name: player.name,
        bingoLines: player.bingoLines,
        marked: player.marked,
      });
    }

    // 빙고 달성 확인 (5줄 = 완전 빙고, 또는 설정에 따라)
    // 여기서는 3줄 빙고로 승리 (7살 아이를 위해 빠른 게임)
    const BINGO_WIN = 3;
    let winnerInfo = null;
    for (const [sid, player] of room.players) {
      if (player.bingoLines >= BINGO_WIN) {
        room.winner = sid;
        winnerInfo = { id: sid, name: player.name, lines: player.bingoLines };
        break;
      }
    }

    // 다음 턴
    room.currentTurn = (room.currentTurn + 1) % room.turnOrder.length;

    // 모든 플레이어에게 결과 전송
    for (const [sid, player] of room.players) {
      io.to(sid).emit('number-called', {
        number,
        callerName,
        calledNumbers: room.calledNumbers,
        myMarked: player.marked,
        myBingoLines: player.bingoLines,
        currentTurn: room.currentTurn,
        playerStates: playerStates.map(ps => ({
          name: ps.name,
          bingoLines: ps.bingoLines,
          isMe: ps.id === sid,
        })),
        winner: winnerInfo,
      });
    }
  });

  // 새 게임 (같은 방에서)
  socket.on('new-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;

    room.calledNumbers = [];
    room.remainingNumbers = [];
    for (let i = 1; i <= 25; i++) room.remainingNumbers.push(i);
    shuffle(room.remainingNumbers);
    room.started = false;
    room.winner = null;
    room.currentTurn = 0;

    for (const [sid, player] of room.players) {
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
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.id);
    const playerName = player ? player.name : '알 수 없음';
    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(code);
      return;
    }

    // 방장이 나가면 다음 사람이 방장
    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
    }

    // 턴 순서 업데이트
    if (room.started) {
      const idx = room.turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        room.turnOrder.splice(idx, 1);
        if (room.currentTurn >= room.turnOrder.length) {
          room.currentTurn = 0;
        }
      }
    }

    io.to(code).emit('player-left', { name: playerName });
    emitPlayerList(room);
  });
});

function emitPlayerList(room) {
  const players = [];
  for (const [sid, p] of room.players) {
    players.push({ name: p.name, isHost: sid === room.host });
  }
  io.to(room.code).emit('player-list', { players, code: room.code });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎱 빙고 게임 서버 시작!`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n같은 Wi-Fi에 있는 기기에서 접속하려면:`);
  // 로컬 IP 출력
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
