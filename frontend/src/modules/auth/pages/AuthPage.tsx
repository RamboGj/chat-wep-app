import { useState } from 'react'
import { SignupForm } from '../components/SignupForm'
import { LoginForm } from '../components/LoginForm'

const AuthTab = {
  LOGIN: 'login',
  SIGNUP: 'signup',
} as const

type AuthTab = (typeof AuthTab)[keyof typeof AuthTab]

const TABS = [
  {
    title: 'Log in',
    value: AuthTab.LOGIN,
  },
  {
    title: 'Sign up',
    value: AuthTab.SIGNUP,
  },
]

export function AuthPage() {
  const [currentTab, setCurrentTab] = useState<AuthTab>(AuthTab.LOGIN)

  const FORM_COMPONENT = new Map([
    [AuthTab.LOGIN, <LoginForm />],
    [AuthTab.SIGNUP, <SignupForm />],
  ])

  return (
    <div>
      <div>
        {TABS.map((tab) => {
          return (
            <button onClick={() => setCurrentTab(tab.value)} key={tab.value}>
              <span>{tab.title}</span>
            </button>
          )
        })}
      </div>

      {FORM_COMPONENT.get(currentTab)}
    </div>
  )
}
