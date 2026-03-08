# 🎱 Bingoelus — Guía del streamer

---

## Iniciar la aplicación

Haz doble clic en el acceso directo **Bingoelus** del escritorio. Se abrirá el panel del gestor.

> La primera vez puede tardar unos segundos mientras conecta con internet.

---

## Antes de empezar: comparte la URL con los jugadores

En la parte superior del panel verás la **URL de jugadores**. Pégala en el chat de Twitch o en un comando de bot para que los espectadores puedan entrar. Los jugadores la abren en su navegador, inician sesión con su cuenta de Twitch y reciben su cartón automáticamente.

---

## Configurar la partida

1. En el cuadro de texto de la izquierda, **pega las frases** del bingo (una por línea o separadas por comas). Mínimo 25 frases.
2. Pulsa **▶ Iniciar Partida**. Todos los jugadores conectados reciben su cartón en ese momento.
3. Opcional: ajusta **"Casillas restantes máx. para ¡Bingo!"** si quieres dar margen de error (0 = todas las casillas deben estar cantadas para poder reclamar bingo).
4. Pulsa el botón 🔓 cuando creas que alguien puede tenerlo

---

## Durante la partida

| Acción | Cómo |
|---|---|
| **Cantar una frase** | Haz clic en ella en el panel central |
| **Descantar** | Haz click en el botón rojo que está junto a ella |
| **Alguien canta línea o bingo** | Aparece un overlay — pulsa **Continuar** para seguir jugando o **Terminar** para acabar |
| **Resetear todo** | Botón 🔄 — borra cartones, cantadas y jugadores (para empezar de cero) |

---

## Música

El panel tiene un reproductor de YouTube integrado. Usa los botones ▶ / ⏸ y la rueda de volumen para controlarlo.

---

## Resultados al terminar

Al pulsar **Terminar**, se guarda automáticamente un archivo de texto con los ganadores de Línea y Bingo en:

```
C:\Users\TU_USUARIO\AppData\Roaming\Bingoelus\resultados\
```

## Ganadores y resultados

Al terminar la partida (botón **Terminar**) se genera automáticamente un archivo de texto con los ganadores.

- **En desarrollo** (`npm start`): se guarda en `resultados/` dentro del proyecto.
- **En el ejecutable instalado**: se guarda en `C:\Users\<usuario>\AppData\Roaming\Bingoelus\resultados\`

El nombre del archivo tiene la fecha y hora de la partida.
