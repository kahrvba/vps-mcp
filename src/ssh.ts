import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';

export class SshClient {
  private client: Client;
  private sftp: SFTPWrapper | null = null;
  private connected: boolean = false;
  private cwd: string = '';

  constructor() {
    this.client = new Client();
  }

  connect(config: ConnectConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client
        .on('ready', () => {
          this.connected = true;
          this.client.sftp((err, sftp) => {
            if (err) {
              this.client.end();
              reject(err);
              return;
            }
            this.sftp = sftp;
            
            // Get initial CWD
            this.client.exec('pwd', (err, stream) => {
                if (err) {
                    // Fallback if pwd fails, though unlikely
                    this.cwd = '~';
                    resolve();
                    return;
                }
                let output = '';
                stream.on('data', (data: any) => { output += data.toString(); })
                      .on('close', () => {
                          this.cwd = output.trim();
                          resolve();
                      });
            });
          });
        })
        .on('error', (err) => {
          this.connected = false;
          reject(err);
        })
        .on('end', () => {
          this.connected = false;
          this.sftp = null;
        })
        .connect(config);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.connected) {
      this.client.end();
      this.connected = false;
      this.sftp = null;
    }
  }

  getCwd(): string {
    return this.cwd;
  }

  async executeCommand(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected to VPS'));
        return;
      }

      // Wrap command with CWD if available
      const wrappedCommand = this.cwd ? `cd "${this.cwd}" && ${command}` : command;

      this.client.exec(wrappedCommand, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code: number, signal: any) => {
            resolve({ stdout, stderr, code });
          })
          .on('data', (data: any) => {
            stdout += data.toString();
          })
          .stderr.on('data', (data: any) => {
            stderr += data.toString();
          });
      });
    });
  }

  async changeDirectory(path: string): Promise<string> {
      const result = await this.executeCommand(`cd "${path}" && pwd`);
      if (result.code !== 0) {
          throw new Error(`Failed to change directory: ${result.stderr || 'Unknown error'}`);
      }
      this.cwd = result.stdout.trim();
      return this.cwd;
  }

  listFiles(path: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this.sftp) {
        reject(new Error('SFTP not available'));
        return;
      }
      
      const targetPath = path.startsWith('/') ? path : `${this.cwd}/${path}`;
      
      this.sftp.readdir(targetPath, (err, list) => {
        if (err) reject(err);
        else resolve(list);
      });
    });
  }

  createDirectory(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
       if (!this.sftp) {
        reject(new Error('SFTP not available'));
        return;
      }
      const targetPath = path.startsWith('/') ? path : `${this.cwd}/${path}`;
      
      this.sftp.mkdir(targetPath, (err) => {
          if (err) reject(err);
          else resolve();
      });
    });
  }

  readFile(path: string): Promise<string> {
      return new Promise((resolve, reject) => {
          if (!this.sftp) {
              reject(new Error('SFTP not available'));
              return;
          }
          const targetPath = path.startsWith('/') ? path : `${this.cwd}/${path}`;

          this.sftp.readFile(targetPath, (err, buffer) => {
              if (err) reject(err);
              else resolve(buffer.toString());
          });
      });
  }

  writeFile(path: string, content: string): Promise<void> {
      return new Promise((resolve, reject) => {
          if (!this.sftp) {
              reject(new Error('SFTP not available'));
              return;
          }
          const targetPath = path.startsWith('/') ? path : `${this.cwd}/${path}`;

          this.sftp.writeFile(targetPath, content, (err) => {
              if (err) reject(err);
              else resolve();
          });
      });
  }

  async deleteItem(path: string): Promise<void> {
      // Use executeCommand for robust recursive deletion (rm -rf)
      // Note: executeCommand already handles cwd prefixing
      const result = await this.executeCommand(`rm -rf "${path}"`);
      if (result.code !== 0) {
          throw new Error(`Failed to delete item: ${result.stderr}`);
      }
  }
}
