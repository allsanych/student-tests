@echo off
color 0A
echo ===================================================
echo     ЗАПУСК СЕРВЕРА СИНХРОНІЗАЦІЇ ТЕСТІВ
echo ===================================================
echo.
echo Підключення до онлайн-сервера на Render...
set SYNC_MASTER_URL=https://student-tests-xcss.onrender.com
node server.js
pause
