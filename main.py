import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from aiogram import Bot, Dispatcher
from aiogram.types import Message, ReplyKeyboardMarkup, KeyboardButton
import os

BOT_TOKEN = os.getenv("BOT_TOKEN")
SITE_URL = os.getenv("SITE_URL", "http://localhost:8000")

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(dp.start_polling(bot))
    print("✅ Bot started")
    yield
    await bot.session.close()

app = FastAPI(lifespan=lifespan)

@dp.message()
async def start(message: Message):
    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="Открыть сайт", web_app={"url": SITE_URL})]],
        resize_keyboard=True
    )
    await message.answer("Открой сайт 👇", reply_markup=kb)

@app.get("/", response_class=HTMLResponse)
async def site():
    return open("index.html", encoding="utf-8").read()

@app.post("/send")
async def send(request: Request):
    data = await request.json()
    await bot.send_message(data["user_id"], f"Вы ввели: {data['value']}")
    return {"ok": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
