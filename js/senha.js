// Password helpers for the e-mail + password login.
//
// The password NEVER leaves the browser. It is stretched into a 256-bit key with
// PBKDF2-SHA256 (210,000 rounds, salted with the person's e-mail) and only that
// key is sent to the gateway, which stores nothing but a salted HMAC of it
// (apps-script/Code.gs). Rules of strength are checked here, where the password is.

// `let` only so the tests can lower the cost; nothing else changes it.
let PBKDF2_ITERACOES = 210000;

function basePara64Url(bytes) {
  let binario = "";
  bytes.forEach((b) => {
    binario += String.fromCharCode(b);
  });
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loginComSenhaDisponivel() {
  return Boolean(window.crypto && window.crypto.subtle && typeof TextEncoder !== "undefined");
}

// A chosen "login" (apelido): letters/numbers/._- , 3-30 chars, no "@" — mirrors
// loginValido_ in apps-script/Code.gs (the server is the real check; this is
// only so the person sees the problem before submitting).
function loginParecido(valor) {
  return /^[A-Za-z0-9._-]{3,30}$/.test(String(valor || ""));
}

// -> a 43-character base64url string (256 bits) that stands in for the password.
async function derivarChaveDeSenha(senha, email) {
  if (!loginComSenhaDisponivel()) {
    throw new Error("Este navegador não permite entrar com senha (é preciso uma conexão segura). Use o login com Google.");
  }
  const codificador = new TextEncoder();
  const material = await window.crypto.subtle.importKey("raw", codificador.encode(String(senha).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await window.crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: codificador.encode("finan.v1:" + canonicalizarEmail(email)), iterations: PBKDF2_ITERACOES },
    material,
    256
  );
  return basePara64Url(new Uint8Array(bits));
}

const SENHAS_COMUNS = [
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345", "111111", "000000", "123123", "654321", "112233",
  "senha", "senha123", "senha1234", "minhasenha", "mudar123", "admin", "admin123", "administrador", "password", "password1", "passw0rd",
  "qwerty", "qwerty123", "qwertyuiop", "abc123", "abcd1234", "abc12345", "iloveyou", "letmein", "welcome", "brasil", "brasil123",
  "flamengo", "corinthians", "palmeiras", "vasco", "gremio", "internacional", "santos", "saopaulo", "botafogo", "fluminense",
  "jesus", "deus", "amor", "amorzinho", "princesa", "gatinho", "cachorro", "ipanema", "recreio", "joias", "finan", "finangold",
];

// -> { nivel: 0-4, rotulo, ok, dica }  (ok = allowed to be used)
function avaliarSenha(senha, email) {
  const texto = String(senha || "");
  const vazia = texto.length === 0;
  if (vazia) return { nivel: 0, rotulo: "", ok: false, dica: "" };
  const minuscula = texto.toLowerCase();
  const local = (limparEmailTexto(email || "").split("@")[0] || "").replace(/[^a-z0-9]/g, "");
  if (texto.length < 8) return { nivel: 1, rotulo: "Curta demais", ok: false, dica: "Use pelo menos 8 caracteres." };
  if (SENHAS_COMUNS.indexOf(minuscula) !== -1 || /^(.)\1+$/.test(texto) || /^(0123456789|1234567890|abcdefgh|qwertyui)/.test(minuscula)) {
    return { nivel: 1, rotulo: "Muito comum", ok: false, dica: "Essa senha é fácil de adivinhar. Misture palavras, números e símbolos." };
  }
  if (local.length >= 4 && minuscula.replace(/[^a-z0-9]/g, "").indexOf(local) !== -1) {
    return { nivel: 1, rotulo: "Parecida com o e-mail", ok: false, dica: "Não use o seu e-mail (ou parte dele) na senha." };
  }
  const temLetra = /[a-zA-Z]/.test(texto);
  const temNumero = /\d/.test(texto);
  const misturaCaixa = /[a-z]/.test(texto) && /[A-Z]/.test(texto);
  const temSimbolo = /[^a-zA-Z0-9]/.test(texto);
  if (!(temLetra && temNumero) && !temSimbolo && texto.length < 12) {
    return { nivel: 1, rotulo: "Fraca", ok: false, dica: "Misture letras e números." };
  }
  let pontos = 1;
  if (texto.length >= 10) pontos += 1;
  if (texto.length >= 14) pontos += 1;
  if (misturaCaixa) pontos += 1;
  if (temSimbolo) pontos += 1;
  if (temLetra && temNumero) pontos += 1;
  const nivel = pontos >= 5 ? 4 : pontos >= 4 ? 3 : 2;
  return { nivel, rotulo: nivel === 4 ? "Forte" : nivel === 3 ? "Boa" : "Razoável", ok: true, dica: nivel === 2 ? "Para ficar mais forte, aumente o tamanho ou use maiúsculas e símbolos." : "" };
}
