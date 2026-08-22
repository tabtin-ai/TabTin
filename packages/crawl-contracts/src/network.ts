/**
 * 网络与代理相关契约
 */
export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol?: 'http' | 'https' | 'socks4' | 'socks5';
}
