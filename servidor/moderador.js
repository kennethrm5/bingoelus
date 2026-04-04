const io = require('socket.io-client');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

let token = '';
try {
  const configPath = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  token = config.gestorToken;
} catch(e) {
  console.log('No se encontro config.json. Ejecuta este script desde dentro de la carpeta "servidor".');
  process.exit(1);
}

const socket = io('http://localhost:3000/gestor', {
  auth: { token: token }
});

let frasesActuales = [];
let marcadasActuales = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'MOD> '
});

console.clear();
console.log('====================================');
console.log('=== PANEL DE MODERADOR BINGOELUS ===');
console.log('====================================');
console.log('Comandos:');
console.log('  ver         -> Muestra todas las frases (las marcadas tienen [X])');
console.log('  t <id>      -> Marca o desmarca la frase con ese ID numérico (ej: "t 5")');
console.log('  salir       -> Cierra el panel');
console.log('====================================\n');

socket.on('connect', () => {
  console.log('🟢 Conectado al servidor.');
});

socket.on('connect_error', (err) => {
  console.error('🔴 Error de conexion:', err.message);
});

socket.on('estado:actual', (estado) => {
  if (estado.frases) frasesActuales = estado.frases;
  if (estado.cantadas) marcadasActuales = estado.cantadas;
  rl.prompt();
});

// Evento que se dispara cuando ALGUIEN (tú o el gestor web) marca globalmente
socket.on('partida:frase-cantada', (data) => {
  if (data.cantadas) {
    marcadasActuales = data.cantadas;
    mostrarFrases();
  }
});

socket.on('partida:frase-descantada', (data) => {
  if (data.cantadas) {
    marcadasActuales = data.cantadas;
    mostrarFrases();
  }
});

function mostrarFrases() {
  console.log('\n--- LISTADO DE FRASES (actualizado) ---');
  frasesActuales.forEach((frase, index) => {
    const isMarked = marcadasActuales.includes(frase);
    console.log(`${index.toString().padStart(2, '0')}: [${isMarked ? 'X' : ' '}] ${frase}`);
  });
  console.log('-------------------------\n');
}

socket.on('gestor:error', (err) => {
  console.log('\n[!] Error del servidor:', err.msg);
  rl.prompt();
});

rl.on('line', (line) => {
  const input = line.trim();
  if (input === 'ver' || input === 'ls') {
    mostrarFrases();
  } else if (input.startsWith('t ') || input.startsWith('toggle ')) {
    const parts = input.split(' ');
    const index = parseInt(parts[1]);
    
    if (!isNaN(index) && frasesActuales[index]) {
      const frase = frasesActuales[index];
      const isMarked = marcadasActuales.includes(frase);
      
      if (isMarked) {
        socket.emit('gestor:desmarcar-frase', { frase });
        console.log(`\n🔵 Desmarcada: ${frase}`);
      } else {
        socket.emit('gestor:cantar-frase', { frase });
        console.log(`\n🔴 Marcada: ${frase}`);
      }
    } else {
      console.log('⚠️ ID inválido. Usa "ver" para consultar la lista de números.');
    }
  } else if (input === 'salir' || input === 'exit') {
    process.exit(0);
  } else if (input !== '') {
    console.log('⚠️ Comando no reconocido.');
  }
  
  setTimeout(() => rl.prompt(), 50);
});

