import { useState } from 'react'
import { SignupForm } from '../components/SignupForm'
import { LoginForm } from '../components/LoginForm'
import { Tab } from '../../../components/atoms/Tab/Tab'

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
    <div className="bg-gray-800 mx-auto max-w-xl my-24 border border-white-25 rounded-l p-10">
      <div className="flex p-0.5 rounded-lg">
        {TABS.map((tab) => {
          const isActive = currentTab === tab.value

          return (
            <Tab
              className="w-90"
              active={isActive}
              value={tab.value}
              title={tab.title}
              onClick={() => setCurrentTab(tab.value)}
              key={tab.value}
            />
          )
        })}
      </div>

      {FORM_COMPONENT.get(currentTab)}
    </div>
  )
}
