const CHATS_MOCK = [
  {
    username: 'Maya Chen',
    lastMessage: {
      content: 'Sent the deck, let me know what you think!',
      timestamp: new Date('2026-07-16T10:00:00Z'),
    },
    isOnline: true,
  },
  {
    username: 'Idris Osei',
    lastMessage: {
      content: 'Yes! See you at 6',
      timestamp: new Date('2026-07-15T10:00:00Z'),
    },
    isOnline: false,
  },
  {
    username: 'Priya Nandakumar',
    lastMessage: {
      content: "😂 that's wild",
      timestamp: new Date('2026-07-16T10:00:00Z'),
    },
    isOnline: true,
  },
  {
    username: 'Sam Okafor',
    lastMessage: {
      content: 'Can we push to Thursday?',
      timestamp: new Date('2026-07-16T10:00:00Z'),
    },
    isOnline: false,
  },
]

const MESSAGES_MOCK = [
  {
    id: '123',
    content: "Hey, how's it going?",
    timestamp: new Date(),
    sender: 'user',
  },
  {
    id: '124',
    content: "Hey, how's it going?",
    timestamp: new Date(),
    sender: 'external',
  },
  {
    id: '125',
    content: "Hey, how's it going?",
    timestamp: new Date(),
    sender: 'user',
  },
  {
    id: '126',
    content: "Hey, how's it going?",
    timestamp: new Date(),
    sender: 'external',
  },
]

export function ChatPage() {
  return (
    <div>
      <header>
        <div>
          <div>
            <span>D</span>
          </div>

          <div>
            <span>Username here</span>
            <span>Pulse messager</span>
          </div>
        </div>

        <div>
          <button>+ New Chat</button>
          <button>Log out</button>
        </div>
      </header>

      <div>
        <aside>
          <fieldset>
            <label className="sr-only" htmlFor="search_chats_input">
              Search chats
            </label>
            <input
              type="text"
              name="search"
              id="search_chats_input"
              placeholder="Search chats"
            />
          </fieldset>

          <ul>
            {CHATS_MOCK.map((chat) => {
              const intials = chat.username
                .split(' ')
                .map((part) => part[0])
                .join('')
                .toUpperCase()

              return (
                <li key={chat.username}>
                  <div>
                    <div>
                      <span>{intials}</span>
                      {chat.isOnline && <div />}
                    </div>

                    <div>
                      <strong>{chat.username}</strong>
                      <p>{chat.lastMessage.content}</p>
                    </div>

                    <span>{chat.lastMessage.timestamp.toString()}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </aside>

        <main>
          <header>
            <div>
              <div>
                <span>MC</span>
              </div>

              <div>
                <strong>Maya Chen</strong>
                <p>Online</p>
              </div>
            </div>
          </header>

          <div>
            <ul>
              {MESSAGES_MOCK.map((message) => (
                <li key={message.id}>
                  <p>{message.content}</p>
                  <span>{message.timestamp.toString()}</span>
                </li>
              ))}
            </ul>
          </div>

          <footer>
            <form>
              <fieldset>
                <label className="sr-only" htmlFor="message_input">
                  Type message
                </label>
                <input
                  type="text"
                  id="message_input"
                  placeholder="Type your message..."
                />
              </fieldset>

              <button aria-label="Send message" type="submit">
                {'>'}
              </button>
            </form>
          </footer>
        </main>
      </div>
    </div>
  )
}
