## Pairing Code Example with @whiskeysockets/baileys

A simple example of a pairing code server that uses `@whiskeysockets/baileys`  and stores session credentials in MEGA with an ID.

## Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/IRON-M4N/pair-example.git
   cd pair-example
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure your MEGA and session settings**
   - Edit `config.js` and set add your Mega account password and email and session prefix

   ```javascript
   module.exports = {
       EMAIL: "your-mega-email",
       PASS: "your-mega-password",
       PREFIX: "IRON-M4N×" // Customize your session ID prefix here
   };
   ```

4. **Run the script**

   ```bash
   npm start
   ```

   - To stop or restart, you can use:
     ```bash
     npm run stop
     npm run restart
     ```

5. **Pairing Usage**
     ```
     http://localhost:3000/pair?code=+6969696969
     ```

##### Readme is made from ChatGpt cuz takes too much energy to make one and explain it sooo...yeah
###### IRON-M4N
