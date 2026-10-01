Pod::Spec.new do |s|
  s.name           = 'VaultMedia'
  s.version        = '0.1.0'
  s.summary        = 'Picking that comes with permission to delete what was picked.'
  s.description    = 'PHPicker-based import that keeps the selected asset identifier so the original can be removed after the vault holds an encrypted copy.'
  s.author         = ''
  s.homepage       = 'https://github.com/krueger100/Silent-Sum'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
