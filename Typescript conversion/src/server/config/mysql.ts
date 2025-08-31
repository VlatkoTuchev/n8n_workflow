import mysql from 'mysql2/promise';
import { env } from '../env';

export const mysqlPool = mysql.createPool({
  host: env.MYSQL_HOST || 'localhost',
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER || 'ai_cdc',
  password: env.MYSQL_PASSWORD || 'ai_cdc_pwd',
  database: env.MYSQL_DB || 'aiatwork',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function mysqlQuery<T = any>(sql: string, params?: any[]) {
  const [rows] = await mysqlPool.execute<T[]>(sql, params);
  return rows;
}


