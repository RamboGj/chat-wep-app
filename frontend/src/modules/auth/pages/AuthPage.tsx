import { useEffect, useRef, useState } from 'react'
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
  const [indicatorStyle, setIndicatorStyle] = useState({
    width: 0,
    x: 0,
  })
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])

  const FORM_COMPONENT = new Map([
    [AuthTab.LOGIN, <LoginForm />],
    [AuthTab.SIGNUP, <SignupForm />],
  ])

  useEffect(() => {
    const activeIndex = TABS.findIndex((tab) => tab.value === currentTab)
    const el = tabsRef.current[activeIndex]

    if (el) {
      setIndicatorStyle({
        width: el.offsetWidth,
        x: el.offsetLeft,
      })
    }
  }, [currentTab])

  return (
    <div className="relative">
      <div className="w-80 h-80 backdrop-blur-[300px]" />

      <div className="bg-gray-800 mx-auto max-w-xl my-24 border border-white-08 rounded-xl p-10">
        <div className="flex p-0.5 rounded-lg relative">
          {TABS.map((tab, index) => {
            const isActive = currentTab === tab.value

            return (
              <Tab
                ref={(el) => {
                  tabsRef.current[index] = el
                }}
                className="w-90"
                active={isActive}
                value={tab.value}
                title={tab.title}
                onClick={() => setCurrentTab(tab.value)}
                key={tab.value}
              />
            )
          })}

          <div
            className="absolute top-0 left-0 h-full rounded-[9px] bg-brand-500 transition-all duration-300"
            style={{
              width: indicatorStyle.width,
              transform: `translateX(${indicatorStyle.x}px)`,
            }}
          />
        </div>

        {FORM_COMPONENT.get(currentTab)}
      </div>
    </div>
  )
}
