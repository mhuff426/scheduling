-- Runs only on first volume initialization. The dev database (ShiftlyDev0)
-- is created by MYSQL_DATABASE; the e2e suite needs its own database so it
-- never touches dev data. The app also does CREATE DATABASE IF NOT EXISTS
-- outside production, which covers pre-existing volumes.
CREATE DATABASE IF NOT EXISTS `ShiftlyE2E0` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
